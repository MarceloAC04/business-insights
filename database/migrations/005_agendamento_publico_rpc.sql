-- ================================================================
-- MIGRATION 005 — RPCs do agendamento público (lote L8, complemento)
-- Salon App · gerado a partir de .specs/endpoints-backend.md §10
-- ================================================================
--
-- Como executar: Supabase Dashboard > SQL Editor > cole e rode.
-- Idempotente (create or replace function) — rodar de novo não quebra.
--
-- Por que isto não é uma migração de tabela: a 003 já criou tudo que o
-- agendamento público lê (servicos.duracao_minutos, horario_funcionamento,
-- perfil_salao.slug_agendamento, atendimentos.origem). O que faltava era
-- ONDE roda a lógica — e aqui é o único módulo sem `auth.uid()` (link
-- público, sem login): a RLS de todo o resto do banco é
-- `using (auth.uid() = user_id)`, que barra qualquer leitura/escrita vinda
-- de um cliente anônimo. Com A1 revogado (frontend fala Supabase direto,
-- sem FastAPI), o papel que o service role do FastAPI cumpria — enxergar
-- através da RLS só para o suficiente (nome do salão, tabela de preços,
-- expediente) e nunca vazar telefone/estoque/custo fixo — passa para estas
-- 3 funções `security definer`, com a mesma lista de colunas que o
-- FastAPI já expunha.
--
-- A segunda razão, mais dura: `agendar` precisa reler a disponibilidade no
-- mesmo instante em que grava (§10 é explícito — não confia no que
-- `horarios-disponiveis` respondeu segundos antes). Duas requisições
-- concorrentes de dois clientes públicos não podem ambas achar o mesmo
-- horário livre e gravar as duas — um `select` seguido de `insert` feito
-- pelo navegador não tem como garantir isso (são duas chamadas
-- independentes, sem transação entre elas). `pg_advisory_xact_lock` por
-- usuária serializa as tentativas de agendar do mesmo salão dentro da
-- própria função, e a revalidação roda de novo depois do lock — mesmo
-- espírito do `ajustar_estoque` (único outro RPC do app, criado para o
-- mesmo tipo de corrida em `estoque_itens`).
-- ================================================================


-- ================================================================
-- 1. PÁGINA PÚBLICA — nome do salão + tabela de preços
-- ================================================================
-- Nunca devolve telefone_whatsapp, custo fixo, estoque ou qualquer outra
-- coluna de perfil_salao/servicos além destas. Só serviço ativo e com
-- duracao_minutos preenchida entra na lista — sem duração não dá para
-- calcular horário nenhum, então não faz sentido oferecer no link.

create or replace function agendamento_publico_pagina(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id uuid;
  v_salao jsonb;
  v_servicos jsonb;
begin
  select user_id, jsonb_build_object('nome', nome_salao, 'foto_url', foto_url)
    into v_user_id, v_salao
    from perfil_salao
    where slug_agendamento = p_slug;

  if v_user_id is null then
    raise exception 'SALAO_NAO_ENCONTRADO';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('id', id, 'nome', nome, 'preco', preco, 'duracao_minutos', duracao_minutos)
             order by nome
           ),
           '[]'::jsonb
         )
    into v_servicos
    from servicos
    where user_id = v_user_id and ativo and duracao_minutos is not null;

  return jsonb_build_object('salao', v_salao, 'servicos', v_servicos);
end;
$fn$;


-- ================================================================
-- 2. HORÁRIOS DISPONÍVEIS
-- ================================================================
-- Gera slots de 30 em 30 min dentro do expediente do dia da semana
-- (decisão B6: por dia, sem exceção de data), descartando os que não
-- cabem antes do fim do expediente ou colidem com atendimento já
-- agendado/finalizado no mesmo dia. Data passada devolve lista vazia,
-- não erro (mesma regra de "sem horário hoje, tenta amanhã").
--
-- Duração de atendimento existente = soma de servicos.duracao_minutos dos
-- seus atendimento_servicos; item avulso (servico_id nulo, ou serviço sem
-- duração cadastrada) assume 30 min — subestimar o bloqueio deixaria
-- horário "livre" que na prática colide.

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

  select ativo, hora_inicio, hora_fim
    into v_ativo, v_hora_inicio, v_hora_fim
    from horario_funcionamento
    where user_id = v_user_id and dia_semana = v_dia_semana;

  if v_ativo is not true or v_hora_inicio is null or v_hora_fim is null then
    return jsonb_build_object('duracao_total_minutos', v_duracao_total, 'horarios', '[]'::jsonb);
  end if;

  v_slot := v_hora_inicio;
  while v_slot + (v_duracao_total || ' minutes')::interval <= v_hora_fim loop
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

  return jsonb_build_object('duracao_total_minutos', v_duracao_total, 'horarios', to_jsonb(v_horarios));
end;
$fn$;


-- ================================================================
-- 3. AGENDAR — confirmação automática (B4), com revalidação atômica
-- ================================================================
-- Recalcula tudo que horarios-disponiveis calculou (expediente, colisão
-- com outro atendimento) e só então grava — dentro do lock, então uma
-- segunda chamada concorrente para o mesmo horário vê o atendimento já
-- inserido pela primeira e recebe HORARIO_INDISPONIVEL. Sem estado
-- "pendente": grava direto como 'agendado' e já gera o alerta (§9).

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

  -- Serializa reservas do mesmo salão: sem isto, duas requisições
  -- simultâneas podem ler "livre" ao mesmo tempo e gravar as duas.
  perform pg_advisory_xact_lock(hashtext(v_user_id::text));

  if p_data <= now() then
    raise exception 'HORARIO_INDISPONIVEL';
  end if;

  v_data_local := (p_data at time zone 'America/Sao_Paulo')::date;
  v_hora_local := (p_data at time zone 'America/Sao_Paulo')::time;
  v_dia_semana := extract(dow from v_data_local)::smallint;
  v_fim := p_data + (v_duracao_total || ' minutes')::interval;

  select ativo, hora_inicio, hora_fim
    into v_ativo, v_hora_inicio, v_hora_fim
    from horario_funcionamento
    where user_id = v_user_id and dia_semana = v_dia_semana;

  if v_ativo is not true or v_hora_inicio is null or v_hora_fim is null
     or v_hora_local < v_hora_inicio
     or v_hora_local + (v_duracao_total || ' minutes')::interval > v_hora_fim then
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

  -- "novo agendamento pelo link" (§9/§10) — mesmo canal in-app que já existe,
  -- sem depender do n8n. Dedupe por atendimento: nunca duplica.
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


-- ================================================================
-- 4. PERMISSÕES
-- ================================================================
-- Estas 3 funções são o único ponto do banco que uma requisição sem
-- `auth.uid()` (a anon key do link público) pode chamar. `security
-- definer` já basta para atravessar a RLS das tabelas por baixo — o
-- grant aqui é só a permissão de invocar a função em si.

grant execute on function agendamento_publico_pagina(text) to anon, authenticated;
grant execute on function agendamento_publico_horarios(text, date, uuid[]) to anon, authenticated;
grant execute on function agendamento_publico_agendar(text, text, text, timestamptz, uuid[]) to anon, authenticated;
