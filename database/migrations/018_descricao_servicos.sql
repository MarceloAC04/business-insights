-- MIGRATION 018 — Descrição dos serviços
-- ============================================================================
-- A descrição é opcional e aparece no catálogo público de agendamento e no
-- cadastro interno. O campo é textual para não limitar a forma de apresentar
-- um serviço; a tela aplica limite de 500 caracteres.

alter table servicos
  add column if not exists descricao text not null default '';

-- A RPC é a fonte do catálogo público. Ela passa a devolver a descrição sem
-- expor estoque, custos ou qualquer dado financeiro interno.
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
               'descricao', coalesce(descricao, ''),
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
