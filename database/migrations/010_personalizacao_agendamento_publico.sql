-- ================================================================
-- MIGRATION 010 — Personalização do agendamento público
-- Salon App
-- ================================================================
-- Acrescenta os dados públicos do salão, categoria livre por serviço e um
-- segundo turno opcional no expediente. Rode depois da 005: esta migração
-- substitui as RPCs públicas para que a pausa entre turnos nunca receba
-- agendamentos.

-- ── Perfil público ──────────────────────────────────────────────────────────

alter table perfil_salao add column if not exists instagram_url text not null default '';
alter table perfil_salao add column if not exists endereco text not null default '';
alter table perfil_salao add column if not exists descricao_publica text not null default '';

-- ── Categoria de serviço ───────────────────────────────────────────────────

alter table servicos add column if not exists categoria text;
update servicos set categoria = 'Outros' where categoria is null or btrim(categoria) = '';
alter table servicos alter column categoria set default 'Outros';
alter table servicos alter column categoria set not null;

do $mig$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'servicos' and constraint_name = 'servicos_categoria_nao_vazia_check'
  ) then
    alter table servicos
      add constraint servicos_categoria_nao_vazia_check
      check (length(btrim(categoria)) between 1 and 60);
  end if;
end $mig$;

-- ── Dois turnos por dia ─────────────────────────────────────────────────────

alter table horario_funcionamento add column if not exists hora_inicio_2 time;
alter table horario_funcionamento add column if not exists hora_fim_2 time;

-- Dia fechado nunca guarda horários residuais. Isso também deixa a constraint
-- abaixo segura para instalações que já tinham dados antes desta migração.
update horario_funcionamento
   set hora_inicio = null,
       hora_fim = null,
       hora_inicio_2 = null,
       hora_fim_2 = null
 where not ativo;

alter table horario_funcionamento drop constraint if exists horario_funcionamento_intervalo_check;
alter table horario_funcionamento
  add constraint horario_funcionamento_intervalo_check
  check (
    (not ativo and hora_inicio is null and hora_fim is null
     and hora_inicio_2 is null and hora_fim_2 is null)
    or
    (ativo
     and hora_inicio is not null
     and hora_fim is not null
     and hora_inicio < hora_fim
     and (
       (hora_inicio_2 is null and hora_fim_2 is null)
       or
       (hora_inicio_2 is not null
        and hora_fim_2 is not null
        and hora_inicio_2 < hora_fim_2
        and hora_fim <= hora_inicio_2)
     ))
  );

-- ── RPC: página pública ────────────────────────────────────────────────────

create or replace function agendamento_publico_pagina(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id uuid;
  v_salao jsonb;
  v_horarios jsonb;
  v_servicos jsonb;
begin
  select
    user_id,
    jsonb_build_object(
      'nome', nome_salao,
      'foto_url', foto_url,
      'telefone_whatsapp', coalesce(telefone, ''),
      'instagram_url', coalesce(instagram_url, ''),
      'endereco', coalesce(endereco, ''),
      'descricao_publica', coalesce(descricao_publica, '')
    )
    into v_user_id, v_salao
    from perfil_salao
    where slug_agendamento = p_slug;

  if v_user_id is null then
    raise exception 'SALAO_NAO_ENCONTRADO';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'dia_semana', dia_semana,
               'ativo', ativo,
               'hora_inicio', hora_inicio,
               'hora_fim', hora_fim,
               'hora_inicio_2', hora_inicio_2,
               'hora_fim_2', hora_fim_2
             ) order by dia_semana
           ),
           '[]'::jsonb
         )
    into v_horarios
    from horario_funcionamento
    where user_id = v_user_id;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', id,
               'nome', nome,
               'categoria', categoria,
               'preco', preco,
               'duracao_minutos', duracao_minutos
             ) order by categoria, nome
           ),
           '[]'::jsonb
         )
    into v_servicos
    from servicos
    where user_id = v_user_id and ativo and duracao_minutos is not null;

  return jsonb_build_object(
    'salao', v_salao || jsonb_build_object('horarios', v_horarios),
    'servicos', v_servicos
  );
end;
$fn$;

-- ── RPC: horários livres em dois turnos ─────────────────────────────────────

create or replace function agendamento_publico_horarios(
  p_slug text,
  p_data date,
  p_servico_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id uuid;
  v_duracao_total int;
  v_encontrados int;
  v_dia_semana smallint;
  v_ativo boolean;
  v_hora_inicio time;
  v_hora_fim time;
  v_hora_inicio_2 time;
  v_hora_fim_2 time;
  v_turno record;
  v_horarios text[] := '{}';
  v_slot time;
  v_slot_inicio_tz timestamptz;
  v_slot_fim_tz timestamptz;
begin
  select user_id into v_user_id from perfil_salao where slug_agendamento = p_slug;
  if v_user_id is null then
    raise exception 'SALAO_NAO_ENCONTRADO';
  end if;

  if p_servico_ids is null or array_length(p_servico_ids, 1) is null then
    raise exception 'SERVICO_INVALIDO';
  end if;

  select coalesce(sum(duracao_minutos), 0), count(*)
    into v_duracao_total, v_encontrados
    from servicos
    where id = any(p_servico_ids) and user_id = v_user_id and ativo and duracao_minutos is not null;

  if v_encontrados <> array_length(p_servico_ids, 1) then
    raise exception 'SERVICO_INVALIDO';
  end if;

  if p_data < (now() at time zone 'America/Sao_Paulo')::date then
    return jsonb_build_object('duracao_total_minutos', v_duracao_total, 'horarios', '[]'::jsonb);
  end if;

  v_dia_semana := extract(dow from p_data)::smallint;
  select ativo, hora_inicio, hora_fim, hora_inicio_2, hora_fim_2
    into v_ativo, v_hora_inicio, v_hora_fim, v_hora_inicio_2, v_hora_fim_2
    from horario_funcionamento
    where user_id = v_user_id and dia_semana = v_dia_semana;

  if v_ativo is not true or v_hora_inicio is null or v_hora_fim is null then
    return jsonb_build_object('duracao_total_minutos', v_duracao_total, 'horarios', '[]'::jsonb);
  end if;

  for v_turno in
    select inicio, fim
      from (values (v_hora_inicio, v_hora_fim), (v_hora_inicio_2, v_hora_fim_2)) as turnos(inicio, fim)
     where inicio is not null and fim is not null
  loop
    v_slot := v_turno.inicio;
    while v_slot + (v_duracao_total || ' minutes')::interval <= v_turno.fim loop
      v_slot_inicio_tz := (p_data + v_slot) at time zone 'America/Sao_Paulo';
      v_slot_fim_tz := v_slot_inicio_tz + (v_duracao_total || ' minutes')::interval;

      if v_slot_inicio_tz > now() and not exists (
        select 1
        from atendimentos a
        where a.user_id = v_user_id
          and a.status in ('agendado', 'finalizado')
          and (a.data at time zone 'America/Sao_Paulo')::date = p_data
          and tstzrange(a.data, a.data + (
                coalesce((
                  select sum(coalesce(sv.duracao_minutos, 30))
                  from atendimento_servicos asv
                  left join servicos sv on sv.id = asv.servico_id
                  where asv.atendimento_id = a.id
                ), 30) || ' minutes'
              )::interval)
            && tstzrange(v_slot_inicio_tz, v_slot_fim_tz)
      ) then
        v_horarios := array_append(v_horarios, to_char(v_slot, 'HH24:MI'));
      end if;

      v_slot := v_slot + interval '30 minutes';
    end loop;
  end loop;

  return jsonb_build_object('duracao_total_minutos', v_duracao_total, 'horarios', to_jsonb(v_horarios));
end;
$fn$;

-- ── RPC: confirmação atômica respeitando a pausa ────────────────────────────

create or replace function agendamento_publico_agendar(
  p_slug text,
  p_cliente_nome text,
  p_cliente_telefone text,
  p_data timestamptz,
  p_servico_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id uuid;
  v_duracao_total int;
  v_encontrados int;
  v_data_local date;
  v_dia_semana smallint;
  v_ativo boolean;
  v_hora_inicio time;
  v_hora_fim time;
  v_hora_inicio_2 time;
  v_hora_fim_2 time;
  v_hora_local time;
  v_fim timestamptz;
  v_atendimento_id uuid;
  v_resultado jsonb;
begin
  select user_id into v_user_id from perfil_salao where slug_agendamento = p_slug;
  if v_user_id is null then
    raise exception 'SALAO_NAO_ENCONTRADO';
  end if;

  if p_cliente_nome is null or length(trim(p_cliente_nome)) = 0 then
    raise exception 'VALIDACAO_INVALIDA';
  end if;
  if p_servico_ids is null or array_length(p_servico_ids, 1) is null then
    raise exception 'SERVICO_INVALIDO';
  end if;

  select coalesce(sum(duracao_minutos), 0), count(*)
    into v_duracao_total, v_encontrados
    from servicos
    where id = any(p_servico_ids) and user_id = v_user_id and ativo and duracao_minutos is not null;
  if v_encontrados <> array_length(p_servico_ids, 1) then
    raise exception 'SERVICO_INVALIDO';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text));
  if p_data <= now() then
    raise exception 'HORARIO_INDISPONIVEL';
  end if;

  v_data_local := (p_data at time zone 'America/Sao_Paulo')::date;
  v_hora_local := (p_data at time zone 'America/Sao_Paulo')::time;
  v_dia_semana := extract(dow from v_data_local)::smallint;
  v_fim := p_data + (v_duracao_total || ' minutes')::interval;

  select ativo, hora_inicio, hora_fim, hora_inicio_2, hora_fim_2
    into v_ativo, v_hora_inicio, v_hora_fim, v_hora_inicio_2, v_hora_fim_2
    from horario_funcionamento
    where user_id = v_user_id and dia_semana = v_dia_semana;

  if v_ativo is not true or v_hora_inicio is null or v_hora_fim is null then
    raise exception 'HORARIO_INDISPONIVEL';
  end if;

  if not (
    (v_hora_local >= v_hora_inicio
      and v_hora_local + (v_duracao_total || ' minutes')::interval <= v_hora_fim)
    or
    (v_hora_inicio_2 is not null
      and v_hora_fim_2 is not null
      and v_hora_local >= v_hora_inicio_2
      and v_hora_local + (v_duracao_total || ' minutes')::interval <= v_hora_fim_2)
  ) then
    raise exception 'HORARIO_INDISPONIVEL';
  end if;

  if exists (
    select 1
    from atendimentos a
    where a.user_id = v_user_id
      and a.status in ('agendado', 'finalizado')
      and (a.data at time zone 'America/Sao_Paulo')::date = v_data_local
      and tstzrange(a.data, a.data + (
            coalesce((
              select sum(coalesce(sv.duracao_minutos, 30))
              from atendimento_servicos asv
              left join servicos sv on sv.id = asv.servico_id
              where asv.atendimento_id = a.id
            ), 30) || ' minutes'
          )::interval)
        && tstzrange(p_data, v_fim)
  ) then
    raise exception 'HORARIO_INDISPONIVEL';
  end if;

  insert into atendimentos (user_id, nome_cliente, telefone_cliente, data, status, origem)
  values (v_user_id, trim(p_cliente_nome), coalesce(p_cliente_telefone, ''), p_data, 'agendado', 'publico')
  returning id into v_atendimento_id;

  insert into atendimento_servicos (atendimento_id, servico_id, nome_servico, preco_snapshot)
  select v_atendimento_id, s.id, s.nome, s.preco
  from servicos s
  where s.id = any(p_servico_ids) and s.user_id = v_user_id;

  insert into alertas (user_id, tipo, severidade, titulo, mensagem, referencia_tipo, referencia_id, chave_dedupe)
  values (
    v_user_id,
    'agendamento_publico_novo',
    'info',
    'Novo agendamento pelo link',
    trim(p_cliente_nome) || ' marcou horário pelo link de agendamento',
    'atendimento',
    v_atendimento_id,
    'agendamento_publico_novo:' || v_atendimento_id::text
  )
  on conflict do nothing;

  select jsonb_build_object(
           'id', v_atendimento_id,
           'data', p_data,
           'status', 'agendado',
           'servicos', jsonb_agg(jsonb_build_object('servico_id', s.id, 'nome', s.nome, 'preco', s.preco))
         )
    into v_resultado
    from servicos s
    where s.id = any(p_servico_ids) and s.user_id = v_user_id;

  return v_resultado;
end;
$fn$;
