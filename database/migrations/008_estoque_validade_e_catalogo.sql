-- ================================================================
-- 008. ESTOQUE POR VALIDADE/ATENDIMENTOS + CATÁLOGO REAL DA THAMIRES
-- ================================================================
-- Pedido do dono do projeto (06/09/2026): além de saldo em unidades, um
-- item de estoque pode "durar" um número de dias depois de aberto (ex.:
-- um pote de creme que seca) ou um número de atendimentos (ex.: quantos
-- atendimentos uma cola de cílios rende antes de acabar) — e a usuária
-- quer ser avisada quando estiver perto do fim, do mesmo jeito que já é
-- avisada de saldo baixo por unidade.
--
-- Este arquivo também cadastra, para a conta real da Thamires, o
-- catálogo de itens que ela passou por WhatsApp — com valores fictícios
-- (ela ajusta o custo/saldo real depois, pela tela) — e os 5 serviços
-- correspondentes (Extensão de cílios, Design de sobrancelhas, Limpeza
-- de pele, Micropigmentação, Protocolo de reconstrução), com preço e
-- duração fictícios, já ligados a alguns dos produtos padrão do
-- catálogo. Idempotente: pode rodar de novo sem duplicar.

-- ================================================================
-- 1. NOVAS COLUNAS EM estoque_itens
-- ================================================================
-- `modo_controle` decide QUAL contador vale o alerta: o de sempre
-- (quantidade_atual x quantidade_minima, já existente) ou um destes
-- dois novos. `duracao_dias`/`duracao_atendimentos` só têm valor
-- quando o modo correspondente está ativo (checado em código, não em
-- constraint — combinação e ausência dependem do modo, e Postgres não
-- tem uma forma legível de expressar isso num único check).
--
-- Sem coluna gerada para o status desses dois modos novos: a regra
-- depende de `now()`, que o Postgres não aceita numa `generated
-- always as` (não é uma expressão imutável). Por isso o cálculo de
-- "quantos dias/atendimentos restam" mora no backend (`estoque_service.
-- py`), do mesmo jeito centralizado em espírito — só não pode ser SQL
-- puro.
alter table estoque_itens add column if not exists modo_controle text not null default 'quantidade';

do $mig$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'estoque_itens_modo_controle_check'
  ) then
    alter table estoque_itens
      add constraint estoque_itens_modo_controle_check
      check (modo_controle in ('quantidade', 'validade_dias', 'validade_atendimentos'));
  end if;
end $mig$;

alter table estoque_itens add column if not exists duracao_dias integer;
alter table estoque_itens add column if not exists duracao_atendimentos integer;

do $mig$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'estoque_itens_duracao_dias_check'
  ) then
    alter table estoque_itens
      add constraint estoque_itens_duracao_dias_check
      check (duracao_dias is null or duracao_dias > 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'estoque_itens_duracao_atendimentos_check'
  ) then
    alter table estoque_itens
      add constraint estoque_itens_duracao_atendimentos_check
      check (duracao_atendimentos is null or duracao_atendimentos > 0);
  end if;
end $mig$;

-- Quando a unidade em uso foi aberta pela última vez — reinicia a
-- contagem de dias. Nula até a primeira entrada registrada num item
-- nesse modo.
alter table estoque_itens add column if not exists unidade_aberta_em timestamptz;

-- Quantos atendimentos já consumiram a unidade aberta atual — reinicia
-- junto com `unidade_aberta_em` a cada entrada.
alter table estoque_itens add column if not exists atendimentos_desde_abertura integer not null default 0;


-- ================================================================
-- 2. NOVAS CATEGORIAS — micropigmentação e protocolos de reconstrução
-- ================================================================
-- A lista que a Thamires mandou cobre dois serviços que o enum de
-- categoria ainda não tinha (só existiam cilios/sobrancelha/
-- limpeza_pele/descartavel/outro).
do $mig$
begin
  if exists (
    select 1 from pg_constraint where conname = 'estoque_itens_categoria_check'
  ) then
    alter table estoque_itens drop constraint estoque_itens_categoria_check;
  end if;
  alter table estoque_itens
    add constraint estoque_itens_categoria_check
    check (categoria in ('cilios', 'sobrancelha', 'limpeza_pele', 'descartavel',
                          'micropigmentacao', 'reconstrucao', 'outro'));
end $mig$;


-- ================================================================
-- 3. LIMPEZA — zera estoque e serviços da conta antes do catálogo novo
-- ================================================================
-- Pedido do dono do projeto (06/09/2026): antes de cadastrar o
-- catálogo real, apagar o que já existe em estoque/kits/serviços
-- dessa conta, para não sobrar item de teste/duplicado misturado com
-- o catálogo novo.
--
-- ⚠️ DESTRUTIVO E IRREVERSÍVEL — apaga de vez, não é soft delete.
-- Escopo restrito ao user_id da Thamires (mesmo `ilike` das seções
-- seguintes); nenhuma outra conta é afetada. Histórico de
-- atendimentos e vendas de kit **não é apagado** — `atendimento_
-- insumos`/`atendimento_servicos`/`kit_vendas` guardam nome e preço
-- em colunas próprias (snapshot), então o registro financeiro do
-- passado continua de pé; só o vínculo com o item/serviço apagado
-- vira nulo (era assim que já funcionava para editar/excluir um
-- item ou serviço em uso — não é comportamento novo desta migração).
--
-- Ordem importa por causa de `on delete restrict`: kit_vendas e
-- kit_itens travam a exclusão de kits/estoque_itens se forem
-- apagados fora de ordem.
--   1. kit_vendas (referencia kits com restrict)
--   2. kits         (cascade → kit_itens; kit_id de estoque_movimentacoes vira null)
--   3. servicos     (cascade → servico_produtos_padrao; servico_id de atendimento_servicos vira null)
--   4. estoque_itens (cascade → estoque_movimentacoes; item_estoque_id de
--                      atendimento_insumos e servico_produtos_padrao vira null/some)
--
-- Se preferir manter o que já está cadastrado e só adicionar o
-- catálogo novo por cima, comente (ou apague) este bloco `do $limpeza$
-- ... end $limpeza$;` antes de rodar — o resto do arquivo continua
-- funcionando (idempotente, não duplica pelo nome).
do $limpeza$
declare
  uid uuid;
begin
  select user_id into uid from perfil_salao where nome_salao ilike '%Thamires%' limit 1;

  if uid is null then
    raise notice '008_estoque_validade_e_catalogo: perfil da Thamires não encontrado — limpeza NÃO executada.';
  else
    delete from kit_vendas where user_id = uid;
    delete from kits where user_id = uid;
    delete from servicos where user_id = uid;
    delete from estoque_itens where user_id = uid;
  end if;
end $limpeza$;


-- ================================================================
-- 4. CATÁLOGO — itens que a Thamires já usa, com valores fictícios
-- ================================================================
-- Localiza a conta dela pelo nome do salão (já gravado em
-- perfil_salao pelo cadastro/onboarding) em vez de um UUID colado à
-- mão — este arquivo, ao contrário de 002_seed_teste.sql, é para
-- rodar em produção, contra a conta real. Se o nome do salão mudar
-- antes disso rodar, ajuste o `ilike` abaixo.
--
-- Cada insert confere se já existe item com o mesmo nome para essa
-- usuária antes de inserir — roda de novo sem duplicar, e não
-- sobrescreve o que ela já tiver editado nesse meio tempo. Como a
-- seção 3 acima já limpou a tabela, essa checagem só importa se você
-- pulou a limpeza ou rodar o arquivo de novo depois.
do $cat$
declare
  uid uuid;
  itens text[][] := array[
    -- [nome, categoria, unidade, quantidade_atual, quantidade_minima, custo_unitario]

    -- Extensão de cílios
    ['Shampoo de limpeza (cílios)', 'cilios', 'ml', '250', '50', '0.08'],
    ['Água', 'cilios', 'ml', '1000', '200', '0.01'],
    ['Ventilador de cílios', 'cilios', 'un', '2', '1', '35.00'],
    ['Pentinho de cílios', 'cilios', 'un', '10', '3', '2.50'],
    ['Papel interfolha', 'cilios', 'cx', '3', '1', '18.00'],
    ['Pad de cílios', 'cilios', 'un', '20', '5', '3.00'],
    ['Fita japonesa', 'cilios', 'cx', '4', '1', '9.00'],
    ['Fita mágica', 'cilios', 'cx', '4', '1', '12.00'],
    ['Microbrush', 'cilios', 'cx', '5', '1', '7.50'],
    ['Pincel de batom', 'cilios', 'un', '6', '2', '4.00'],
    ['Primer para cílios', 'cilios', 'un', '3', '1', '22.00'],
    ['Finalizador de cílios', 'cilios', 'un', '3', '1', '25.00'],
    ['Cola de cílios', 'cilios', 'un', '4', '2', '65.00'],
    ['Fios de cílios (diversos)', 'cilios', 'cx', '15', '4', '30.00'],
    ['Placa de cílios', 'cilios', 'un', '3', '1', '15.00'],
    ['Anel de cílios', 'cilios', 'un', '5', '2', '8.00'],
    ['Pinças de cílios', 'cilios', 'un', '4', '1', '45.00'],

    -- Design de sobrancelhas
    ['Espuma de limpeza', 'sobrancelha', 'ml', '300', '60', '0.06'],
    ['Tônico facial', 'sobrancelha', 'ml', '300', '60', '0.07'],
    ['Gel hidratante', 'sobrancelha', 'g', '250', '50', '0.05'],
    ['Linha para sobrancelha', 'sobrancelha', 'un', '10', '3', '5.00'],
    ['Lápis preto', 'sobrancelha', 'un', '5', '2', '6.00'],
    ['Lápis demográfico', 'sobrancelha', 'un', '5', '2', '9.00'],
    ['Esferas de sobrancelha', 'sobrancelha', 'cx', '4', '1', '10.00'],
    ['Pinça de sobrancelhas', 'sobrancelha', 'un', '4', '1', '38.00'],
    ['Cera quente', 'sobrancelha', 'g', '1000', '200', '0.04'],
    ['Palito para cera', 'sobrancelha', 'cx', '5', '1', '8.00'],
    ['Palito para henna', 'sobrancelha', 'cx', '5', '1', '8.00'],
    ['Henna', 'sobrancelha', 'un', '6', '2', '18.00'],
    ['Algodão', 'sobrancelha', 'cx', '6', '2', '7.00'],
    ['Fita de depilação', 'sobrancelha', 'cx', '4', '1', '14.00'],
    ['Óleo removedor de cera', 'sobrancelha', 'ml', '250', '50', '0.06'],
    ['Paquímetro', 'sobrancelha', 'un', '1', '1', '28.00'],
    ['Tesoura de sobrancelha', 'sobrancelha', 'un', '2', '1', '32.00'],
    ['Cubeta', 'sobrancelha', 'un', '6', '2', '4.50'],

    -- Limpeza de pele
    ['Esfoliante facial', 'limpeza_pele', 'g', '250', '50', '0.09'],
    ['Máscara vulcânica', 'limpeza_pele', 'g', '500', '100', '0.06'],
    ['Gaze', 'limpeza_pele', 'cx', '4', '1', '11.00'],
    ['Máscara facial para limpeza de pele', 'limpeza_pele', 'un', '10', '3', '5.50'],
    ['Emoliente', 'limpeza_pele', 'ml', '250', '50', '0.08'],
    ['Gel revitalizante', 'limpeza_pele', 'g', '250', '50', '0.07'],
    ['Ponteira de alta frequência', 'limpeza_pele', 'un', '2', '1', '60.00'],
    ['Vaporizador facial (equipamento)', 'limpeza_pele', 'un', '1', '1', '450.00'],
    ['Cureta de extração', 'limpeza_pele', 'un', '3', '1', '9.00'],

    -- Micropigmentação
    ['Agulha de micropigmentação', 'micropigmentacao', 'cx', '4', '1', '35.00'],
    ['Dermógrafo', 'micropigmentacao', 'un', '1', '1', '380.00'],
    ['Anel para pigmento', 'micropigmentacao', 'cx', '5', '1', '6.00'],
    ['Pigmento', 'micropigmentacao', 'un', '6', '2', '48.00'],
    ['Anestésico', 'micropigmentacao', 'un', '3', '1', '25.00'],
    ['Papel filme', 'micropigmentacao', 'cx', '3', '1', '10.00'],

    -- Protocolos de reconstrução
    ['Sérum facial', 'reconstrucao', 'ml', '200', '40', '0.15'],
    ['Rolo de jade', 'reconstrucao', 'un', '2', '1', '32.00']
  ];
begin
  select user_id into uid from perfil_salao where nome_salao ilike '%Thamires%' limit 1;

  if uid is null then
    raise notice '008_estoque_validade_e_catalogo: perfil da Thamires não encontrado (nome_salao não bate com %%Thamires%%) — catálogo NÃO inserido. Rode de novo depois que o perfil existir.';
  else
    for i in 1 .. array_length(itens, 1) loop
      if not exists (
        select 1 from estoque_itens
        where user_id = uid and nome = itens[i][1]
      ) then
        insert into estoque_itens
          (user_id, nome, categoria, unidade,
           quantidade_atual, quantidade_minima, custo_medio, custo_ultima_compra)
        values
          (uid, itens[i][1], itens[i][2], itens[i][3],
           itens[i][4]::numeric, itens[i][5]::numeric, itens[i][6]::numeric, itens[i][6]::numeric);
      end if;
    end loop;
  end if;
end $cat$;


-- ================================================================
-- 5. SERVIÇOS — os 5 serviços que a Thamires já faz, com preço e
--    duração fictícios, ligados aos produtos padrão do catálogo acima
-- ================================================================
-- Um serviço por categoria da lista que ela mandou. `duracao_minutos`
-- é obrigatório para todo serviço ativo assim que o agendamento
-- público está em uso (§1 de 003_agendamento_publico.sql) — por isso
-- todo serviço abaixo já nasce com duração preenchida, não fictícia
-- no sentido de "poderia faltar", só no sentido de "ela ajusta o
-- número real depois". Preço e produtos padrão: mesma ideia.
--
-- Idempotente: confere serviço existente pelo nome antes de inserir,
-- e produto padrão existente por (servico, item) antes de linkar —
-- roda de novo sem duplicar.
do $srv$
declare
  uid uuid;
  sid uuid;
  -- [nome do serviço, preço, duração em minutos]
  servicos_novos text[][] := array[
    ['Extensão de cílios', '180.00', '90'],
    ['Design de sobrancelhas', '60.00', '40'],
    ['Limpeza de pele', '120.00', '60'],
    ['Micropigmentação', '350.00', '120'],
    ['Protocolo de reconstrução', '150.00', '60']
  ];
  -- [nome do serviço, nome do item no catálogo acima, quantidade]
  produtos_padrao_novos text[][] := array[
    ['Extensão de cílios', 'Cola de cílios', '1'],
    ['Extensão de cílios', 'Fios de cílios (diversos)', '1'],
    ['Extensão de cílios', 'Primer para cílios', '1'],

    ['Design de sobrancelhas', 'Henna', '1'],
    ['Design de sobrancelhas', 'Cera quente', '10'],
    ['Design de sobrancelhas', 'Linha para sobrancelha', '1'],

    ['Limpeza de pele', 'Esfoliante facial', '10'],
    ['Limpeza de pele', 'Máscara vulcânica', '20'],
    ['Limpeza de pele', 'Gaze', '1'],

    ['Micropigmentação', 'Pigmento', '1'],
    ['Micropigmentação', 'Agulha de micropigmentação', '1'],
    ['Micropigmentação', 'Anestésico', '1'],

    ['Protocolo de reconstrução', 'Sérum facial', '10'],
    ['Protocolo de reconstrução', 'Rolo de jade', '1']
  ];
begin
  select user_id into uid from perfil_salao where nome_salao ilike '%Thamires%' limit 1;

  if uid is null then
    raise notice '008_estoque_validade_e_catalogo: perfil da Thamires não encontrado — serviços NÃO inseridos.';
  else
    for i in 1 .. array_length(servicos_novos, 1) loop
      if not exists (select 1 from servicos where user_id = uid and nome = servicos_novos[i][1]) then
        insert into servicos (user_id, nome, preco, duracao_minutos, ativo)
        values (uid, servicos_novos[i][1], servicos_novos[i][2]::numeric, servicos_novos[i][3]::integer, true);
      end if;
    end loop;

    for i in 1 .. array_length(produtos_padrao_novos, 1) loop
      select id into sid from servicos where user_id = uid and nome = produtos_padrao_novos[i][1];
      if sid is not null then
        insert into servico_produtos_padrao (servico_id, item_estoque_id, quantidade)
        select sid, e.id, produtos_padrao_novos[i][3]::numeric
          from estoque_itens e
         where e.user_id = uid and e.nome = produtos_padrao_novos[i][2]
           and not exists (
             select 1 from servico_produtos_padrao spp
              where spp.servico_id = sid and spp.item_estoque_id = e.id
           );
      end if;
    end loop;
  end if;
end $srv$;
