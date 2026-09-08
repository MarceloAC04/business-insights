-- ================================================================
-- 014. FLUXOS DE ESTOQUE ATÔMICOS
-- ================================================================
-- Etapa 4 do roadmap. A baixa de atendimento, seu estorno e as operações
-- de kit precisam gravar saldo, histórico e estado de negócio juntos. A API
-- chama estas funções apenas com service_role, depois de extrair a usuária do
-- JWT; p_user_id nunca vem do cliente.
--
-- Aplicar após 011, 012 e 013. As funções não alteram dados existentes e
-- podem ser criadas antes da publicação do FastAPI que as chama.

begin;

create or replace function public.finalizar_atendimento_estoque(
  p_atendimento_id uuid,
  p_user_id uuid,
  p_materiais jsonb,
  p_confirmar_estoque_insuficiente boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
  v_invalidos jsonb;
  v_faltantes jsonb := '[]'::jsonb;
  v_falta jsonb;
begin
  select a.status into v_status
    from atendimentos a
   where a.id = p_atendimento_id
     and a.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('codigo', 'RECURSO_NAO_ENCONTRADO');
  end if;

  if v_status <> 'agendado' then
    return jsonb_build_object('codigo', 'ATENDIMENTO_STATUS_INVALIDO');
  end if;

  -- Compara como texto antes de converter para UUID: um identificador inválido
  -- também é erro de validação, nunca erro interno da função.
  select coalesce(jsonb_agg(distinct m.item_id), '[]'::jsonb) into v_invalidos
    from (
      select nullif(btrim(x.material ->> 'item_estoque_id'), '') as item_id
        from jsonb_array_elements(coalesce(p_materiais, '[]'::jsonb)) x(material)
    ) m
    left join estoque_itens e
      on e.id::text = m.item_id
     and e.user_id = p_user_id
   where m.item_id is not null
     and e.id is null;

  if jsonb_array_length(v_invalidos) > 0 then
    return jsonb_build_object(
      'codigo', 'VALIDACAO_INVALIDA',
      'item_estoque_ids', v_invalidos
    );
  end if;

  -- A ordem estável reduz risco de deadlock quando dois atendimentos consomem
  -- os mesmos itens em ordens diferentes. As travas ficam até o fim da RPC.
  perform 1
    from estoque_itens e
    join (
      select distinct nullif(btrim(x.material ->> 'item_estoque_id'), '') as item_id
        from jsonb_array_elements(coalesce(p_materiais, '[]'::jsonb)) x(material)
    ) m on m.item_id = e.id::text
   where e.user_id = p_user_id
   order by e.id
   for update of e;

  with demandas as (
    select
      e.id,
      e.nome,
      e.unidade,
      e.quantidade_atual,
      e.modo_controle,
      e.usos_por_unidade,
      sum((x.material ->> 'quantidade')::numeric) as quantidade_consumida
    from jsonb_array_elements(coalesce(p_materiais, '[]'::jsonb)) x(material)
    join estoque_itens e
      on e.id::text = nullif(btrim(x.material ->> 'item_estoque_id'), '')
     and e.user_id = p_user_id
    where nullif(btrim(x.material ->> 'item_estoque_id'), '') is not null
    group by e.id, e.nome, e.unidade, e.quantidade_atual, e.modo_controle, e.usos_por_unidade
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'item_estoque_id', id,
    'nome', nome,
    'unidade', unidade,
    'unidade_consumo', case when modo_controle = 'rendimento_usos' then 'uso' else unidade end,
    'quantidade_solicitada', quantidade_consumida,
    'quantidade_disponivel', case
      when modo_controle = 'rendimento_usos' then quantidade_atual * usos_por_unidade
      else quantidade_atual
    end,
    'deficit', quantidade_consumida - case
      when modo_controle = 'rendimento_usos' then quantidade_atual * usos_por_unidade
      else quantidade_atual
    end
  )), '[]'::jsonb)
  into v_faltantes
  from demandas
  where (case
    when modo_controle = 'rendimento_usos' then quantidade_atual * usos_por_unidade
    else quantidade_atual
  end) < quantidade_consumida;

  if jsonb_array_length(v_faltantes) > 0 and not p_confirmar_estoque_insuficiente then
    return jsonb_build_object('codigo', 'ESTOQUE_INSUFICIENTE', 'faltantes', v_faltantes);
  end if;

  -- Guarda os materiais como foram confirmados, incluindo material avulso;
  -- para item cadastrado, nome e custo vêm do item travado, não do cliente.
  insert into atendimento_insumos (
    atendimento_id, item_estoque_id, nome, quantidade, preco, unidade_consumo
  )
  select
    p_atendimento_id,
    e.id,
    coalesce(e.nome, x.material ->> 'nome'),
    (x.material ->> 'quantidade')::numeric,
    case
      when e.id is not null and e.modo_controle = 'rendimento_usos'
        then e.custo_medio / e.usos_por_unidade
      when e.id is not null then e.custo_medio
      else coalesce((x.material ->> 'preco')::numeric, 0)
    end,
    case
      when e.id is null then null
      when e.modo_controle = 'rendimento_usos' then 'uso'
      else e.unidade
    end
  from jsonb_array_elements(coalesce(p_materiais, '[]'::jsonb)) x(material)
  left join estoque_itens e
    on e.id::text = nullif(btrim(x.material ->> 'item_estoque_id'), '')
   and e.user_id = p_user_id;

  with demandas as (
    select
      e.id,
      e.custo_medio,
      e.modo_controle,
      e.usos_por_unidade,
      sum((x.material ->> 'quantidade')::numeric) as quantidade_consumida,
      case when e.modo_controle = 'rendimento_usos' then 'uso' else e.unidade end as unidade_consumo,
      case
        when e.modo_controle = 'rendimento_usos'
          then sum((x.material ->> 'quantidade')::numeric) / e.usos_por_unidade
        else sum((x.material ->> 'quantidade')::numeric)
      end as quantidade_fisica,
      case
        when e.modo_controle = 'rendimento_usos'
          then e.quantidade_atual * e.usos_por_unidade < sum((x.material ->> 'quantidade')::numeric)
        else e.quantidade_atual < sum((x.material ->> 'quantidade')::numeric)
      end as forcada
    from jsonb_array_elements(coalesce(p_materiais, '[]'::jsonb)) x(material)
    join estoque_itens e
      on e.id::text = nullif(btrim(x.material ->> 'item_estoque_id'), '')
     and e.user_id = p_user_id
    where nullif(btrim(x.material ->> 'item_estoque_id'), '') is not null
    group by e.id, e.custo_medio, e.modo_controle, e.usos_por_unidade, e.unidade, e.quantidade_atual
  ), atualizados as (
    update estoque_itens e
       set quantidade_atual = e.quantidade_atual - d.quantidade_fisica
      from demandas d
     where e.id = d.id
    returning e.id
  )
  insert into estoque_movimentacoes (
    user_id, item_id, tipo, quantidade, quantidade_consumida, unidade_consumo,
    motivo, custo_unitario, atendimento_id, forcada
  )
  select
    p_user_id, d.id, 'saida', d.quantidade_fisica, d.quantidade_consumida,
    d.unidade_consumo, 'Consumo em atendimento', d.custo_medio,
    p_atendimento_id, d.forcada
  from demandas d
  join atualizados a on a.id = d.id;

  -- O resumo usa a composição padrão e o custo vigente ao fechar, congelados
  -- por serviço. A baixa efetiva acima continua sendo a que a usuária confirmou.
  update atendimento_servicos ats
     set custo_insumos_snapshot = coalesce((
       select sum(
         spp.quantidade * case
           when e.modo_controle = 'rendimento_usos' then e.custo_medio / e.usos_por_unidade
           else e.custo_medio
         end
       )
       from servico_produtos_padrao spp
       join estoque_itens e
         on e.id = spp.item_estoque_id
        and e.user_id = p_user_id
       where spp.servico_id = ats.servico_id
     ), 0)
   where ats.atendimento_id = p_atendimento_id
     and ats.servico_id is not null;

  if jsonb_array_length(v_faltantes) > 0 then
    for v_falta in select * from jsonb_array_elements(v_faltantes)
    loop
      insert into alertas (
        user_id, tipo, severidade, titulo, mensagem,
        referencia_tipo, referencia_id, chave_dedupe
      ) values (
        p_user_id, 'estoque_negativo', 'alerta',
        'Estoque negativo: ' || (v_falta ->> 'nome'),
        (v_falta ->> 'nome') || ' ficou com saldo negativo após o atendimento',
        'estoque_item', (v_falta ->> 'item_estoque_id')::uuid,
        'estoque_negativo:' || (v_falta ->> 'item_estoque_id') || ':' || p_atendimento_id::text
      );
    end loop;
  end if;

  update atendimentos
     set status = 'finalizado', finalizado_em = now()
   where id = p_atendimento_id
     and user_id = p_user_id;

  return jsonb_build_object('codigo', 'OK');
end;
$fn$;


create or replace function public.cancelar_atendimento_estoque(
  p_atendimento_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
begin
  select a.status into v_status
    from atendimentos a
   where a.id = p_atendimento_id
     and a.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('codigo', 'RECURSO_NAO_ENCONTRADO');
  end if;

  if v_status = 'cancelado' then
    return jsonb_build_object('codigo', 'ATENDIMENTO_STATUS_INVALIDO');
  end if;

  if v_status = 'finalizado' then
    perform 1
      from estoque_itens e
      join (
        select distinct m.item_id
          from estoque_movimentacoes m
         where m.atendimento_id = p_atendimento_id
           and m.tipo = 'saida'
           and m.motivo = 'Consumo em atendimento'
      ) m on m.item_id = e.id
     where e.user_id = p_user_id
     order by e.id
     for update of e;

    with estornos as (
      select
        m.item_id,
        sum(m.quantidade) as quantidade,
        sum(m.quantidade_consumida) as quantidade_consumida,
        max(m.unidade_consumo) as unidade_consumo
      from estoque_movimentacoes m
      join estoque_itens e on e.id = m.item_id and e.user_id = p_user_id
      where m.atendimento_id = p_atendimento_id
        and m.tipo = 'saida'
        and m.motivo = 'Consumo em atendimento'
      group by m.item_id
    ), atualizados as (
      update estoque_itens e
         set quantidade_atual = e.quantidade_atual + x.quantidade
        from estornos x
       where e.id = x.item_id
      returning e.id
    )
    insert into estoque_movimentacoes (
      user_id, item_id, tipo, quantidade, quantidade_consumida, unidade_consumo,
      motivo, atendimento_id, forcada
    )
    select
      p_user_id, x.item_id, 'ajuste', x.quantidade, x.quantidade_consumida,
      x.unidade_consumo, 'Estorno — atendimento cancelado', p_atendimento_id, false
    from estornos x
    join atualizados a on a.id = x.item_id;

    update alertas al
       set resolvido_em = now()
     where al.user_id = p_user_id
       and al.resolvido_em is null
       and al.chave_dedupe like 'estoque_negativo:%:' || p_atendimento_id::text;
  end if;

  update atendimentos
     set status = 'cancelado', cancelado_em = now()
   where id = p_atendimento_id
     and user_id = p_user_id;

  return jsonb_build_object('codigo', 'OK');
end;
$fn$;


create or replace function public.montar_kit_estoque(
  p_kit_id uuid,
  p_user_id uuid,
  p_quantidade numeric,
  p_confirmar_estoque_insuficiente boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_kit kits%rowtype;
  v_faltantes jsonb := '[]'::jsonb;
begin
  select * into v_kit
    from kits k
   where k.id = p_kit_id
     and k.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('codigo', 'RECURSO_NAO_ENCONTRADO');
  end if;

  if not exists (select 1 from kit_itens where kit_id = p_kit_id) then
    return jsonb_build_object('codigo', 'KIT_SEM_COMPOSICAO');
  end if;

  if exists (
    select 1 from kit_itens ki
    left join estoque_itens e on e.id = ki.item_estoque_id and e.user_id = p_user_id
    where ki.kit_id = p_kit_id and e.id is null
  ) then
    return jsonb_build_object('codigo', 'VALIDACAO_INVALIDA');
  end if;

  perform 1
    from estoque_itens e
    join kit_itens ki on ki.item_estoque_id = e.id
   where ki.kit_id = p_kit_id
     and e.user_id = p_user_id
   order by e.id
   for update of e;

  with demandas as (
    select e.id, e.nome, e.unidade, e.quantidade_atual, ki.quantidade * p_quantidade as quantidade
    from kit_itens ki
    join estoque_itens e on e.id = ki.item_estoque_id and e.user_id = p_user_id
    where ki.kit_id = p_kit_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'item_estoque_id', id,
    'nome', nome,
    'unidade', unidade,
    'quantidade_solicitada', quantidade,
    'quantidade_disponivel', quantidade_atual,
    'deficit', quantidade - quantidade_atual
  )), '[]'::jsonb)
  into v_faltantes
  from demandas
  where quantidade_atual < quantidade;

  if jsonb_array_length(v_faltantes) > 0 and not p_confirmar_estoque_insuficiente then
    return jsonb_build_object('codigo', 'ESTOQUE_INSUFICIENTE', 'faltantes', v_faltantes);
  end if;

  with demandas as (
    select
      e.id, e.custo_medio, ki.quantidade * p_quantidade as quantidade,
      e.quantidade_atual < ki.quantidade * p_quantidade as forcada
    from kit_itens ki
    join estoque_itens e on e.id = ki.item_estoque_id and e.user_id = p_user_id
    where ki.kit_id = p_kit_id
  ), atualizados as (
    update estoque_itens e
       set quantidade_atual = e.quantidade_atual - d.quantidade
      from demandas d
     where e.id = d.id
    returning e.id
  )
  insert into estoque_movimentacoes (
    user_id, item_id, tipo, quantidade, motivo, custo_unitario, kit_id, forcada
  )
  select
    p_user_id, d.id, 'saida', d.quantidade, 'Montagem de kit',
    d.custo_medio, p_kit_id, d.forcada
  from demandas d
  join atualizados a on a.id = d.id;

  update kits
     set quantidade_montada = quantidade_montada + p_quantidade
   where id = p_kit_id
     and user_id = p_user_id;

  return jsonb_build_object('codigo', 'OK');
end;
$fn$;


create or replace function public.vender_kit_estoque(
  p_kit_id uuid,
  p_user_id uuid,
  p_quantidade numeric,
  p_preco_unitario numeric default null,
  p_forma_pagamento text default 'a_vista',
  p_data timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_kit kits%rowtype;
  v_custo_total numeric := 0;
begin
  select * into v_kit
    from kits k
   where k.id = p_kit_id
     and k.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('codigo', 'RECURSO_NAO_ENCONTRADO');
  end if;

  if v_kit.quantidade_montada < p_quantidade then
    return jsonb_build_object(
      'codigo', 'KIT_NAO_MONTADO',
      'quantidade_montada', v_kit.quantidade_montada,
      'quantidade_solicitada', p_quantidade
    );
  end if;

  select coalesce(sum(ki.quantidade * e.custo_medio), 0) into v_custo_total
    from kit_itens ki
    left join estoque_itens e on e.id = ki.item_estoque_id and e.user_id = p_user_id
   where ki.kit_id = p_kit_id;

  update kits
     set quantidade_montada = quantidade_montada - p_quantidade
   where id = p_kit_id
     and user_id = p_user_id;

  insert into kit_vendas (
    user_id, kit_id, quantidade, nome_snapshot, preco_unitario,
    custo_snapshot, forma_pagamento, data
  ) values (
    p_user_id, p_kit_id, p_quantidade, v_kit.nome,
    coalesce(p_preco_unitario, v_kit.preco_venda), v_custo_total,
    p_forma_pagamento, coalesce(p_data, now())
  );

  return jsonb_build_object('codigo', 'OK');
end;
$fn$;

revoke all on function public.finalizar_atendimento_estoque(uuid, uuid, jsonb, boolean) from public;
revoke all on function public.cancelar_atendimento_estoque(uuid, uuid) from public;
revoke all on function public.montar_kit_estoque(uuid, uuid, numeric, boolean) from public;
revoke all on function public.vender_kit_estoque(uuid, uuid, numeric, numeric, text, timestamptz) from public;

grant execute on function public.finalizar_atendimento_estoque(uuid, uuid, jsonb, boolean) to service_role;
grant execute on function public.cancelar_atendimento_estoque(uuid, uuid) to service_role;
grant execute on function public.montar_kit_estoque(uuid, uuid, numeric, boolean) to service_role;
grant execute on function public.vender_kit_estoque(uuid, uuid, numeric, numeric, text, timestamptz) to service_role;

commit;
