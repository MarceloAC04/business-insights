-- ================================================================
-- 012. ESTOQUE POR RENDIMENTO TOTAL DE USOS
-- ================================================================
-- Etapa 2 do roadmap (07/09/2026). Um item em rendimento guarda a
-- quantidade física de embalagens e expõe a capacidade em usos no FastAPI:
-- quantidade_atual × usos_por_unidade.
--
-- Segurança de migração: só itens antigos de `validade_atendimentos` já
-- cadastrados em `un` e fora de kits são convertidos. Estoque em ml/g/caixa
-- não pode virar quantidade de potes sem informar o conteúdo de cada
-- embalagem; permanece legado para conferência explícita na tela. Itens de
-- kit também ficam legados até a etapa 4. A composição de serviço dos itens
-- convertidos muda de fração física para uso, preservando consumo e
-- custo: (fração × usos) × (custo / usos) = fração × custo.
--
-- Aplicar depois de 011. Idempotente: a multiplicação da composição roda
-- apenas enquanto o item ainda está no modo legado.

begin;

alter table public.estoque_itens
  add column if not exists usos_por_unidade numeric(12, 3),
  add column if not exists usos_minimos numeric(12, 3) not null default 0;

alter table public.estoque_itens
  drop constraint if exists estoque_itens_modo_controle_check;
alter table public.estoque_itens
  add constraint estoque_itens_modo_controle_check
  check (modo_controle in (
    'quantidade',
    'rendimento_usos',
    'validade_dias',
    'validade_atendimentos'
  ));

alter table public.estoque_itens
  drop constraint if exists estoque_itens_usos_por_unidade_check;
alter table public.estoque_itens
  add constraint estoque_itens_usos_por_unidade_check
  check (usos_por_unidade is null or usos_por_unidade > 0);

alter table public.estoque_itens
  drop constraint if exists estoque_itens_usos_minimos_check;
alter table public.estoque_itens
  add constraint estoque_itens_usos_minimos_check
  check (usos_minimos >= 0);

alter table public.estoque_movimentacoes
  add column if not exists quantidade_consumida numeric(12, 3),
  add column if not exists unidade_consumo text;

alter table public.atendimento_insumos
  add column if not exists unidade_consumo text;

-- Primeiro converte a composição enquanto `quantidade` ainda significa fração
-- da embalagem. Depois do update do modo, uma nova execução não entra aqui.
update public.servico_produtos_padrao spp
   set quantidade = spp.quantidade * e.duracao_atendimentos
  from public.estoque_itens e
 where spp.item_estoque_id = e.id
   and e.modo_controle = 'validade_atendimentos'
   and e.unidade = 'un'
   and e.duracao_atendimentos is not null
   and e.duracao_atendimentos > 0
   and not exists (
     select 1 from public.kit_itens ki where ki.item_estoque_id = e.id
   );

update public.estoque_itens
   set modo_controle = 'rendimento_usos',
       usos_por_unidade = duracao_atendimentos,
       usos_minimos = least(3, duracao_atendimentos)
  where modo_controle = 'validade_atendimentos'
    and unidade = 'un'
    and duracao_atendimentos is not null
    and duracao_atendimentos > 0
    -- Kit continua com composição física até a etapa 4. Converter este item
    -- agora mudaria o significado de uma quantidade já cadastrada no kit.
    and not exists (
      select 1 from public.kit_itens ki where ki.item_estoque_id = estoque_itens.id
    );

commit;
