-- ================================================================
-- 009. AJUSTE DE MODO_CONTROLE + PRODUTOS PADRÃO COMPLETOS
-- ================================================================
-- Correção pedida pelo dono do projeto (06/09/2026) depois de rodar a
-- 008 em produção: os serviços cadastrados lá só linkavam uma amostra
-- de 2-3 produtos por serviço, e o modo de controle de todo item
-- ficou "quantidade" (saldo por unidade) — errado para item que não
-- se conta em unidade inteira por atendimento. Ex. citado por ele:
-- Henna não é "1 unidade" por atendimento, é um pote que rende várias
-- aplicações antes de acabar.
--
-- Critério usado para classificar cada item do catálogo da 008:
--   • Equipamento reutilizável, não se consome por atendimento
--     (dermógrafo, pinças, tesoura, vaporizador...) → continua
--     "quantidade" (é só "eu ainda tenho o equipamento"), e NÃO entra
--     em servico_produtos_padrao (não deveria baixar saldo a cada
--     atendimento).
--   • Descartável/tangível, se gasta em unidade(s) inteiras contáveis
--     por atendimento (gaze, microbrush, fita, algodão...) → continua
--     "quantidade", mas agora entra em servico_produtos_padrao com a
--     quantidade de fato usada por atendimento.
--   • Produto de pote/frasco compartilhado que se gasta em USO (cola,
--     henna, cera, pigmento, anestésico, sérum) → "validade_
--     atendimentos": quantos atendimentos o pote/frasco aberto rende
--     antes de precisar abrir outro. Continua ligado a
--     servico_produtos_padrao com uma quantidade pequena (fração do
--     frasco), porque as duas contagens são independentes: saldo (pra
--     saber quando comprar mais) e "abriu há quantos atendimentos"
--     (pra saber quando o frasco atual provavelmente já ressecou/
--     venceu, mesmo sem ter esvaziado).
--   • Produto que resseca/vence pelo tempo aberto, não pelo uso
--     (espuma, tônico, gel, esfoliante, máscara vulcânica, emoliente)
--     → "validade_dias": conta a partir de quando a unidade foi
--     aberta, não de quantos atendimentos.
--
-- Valores de duração são fictícios (mesmo espírito da 008) — a
-- Thamires ajusta pela tela depois. Idempotente: pode rodar de novo
-- sem duplicar nem reabrir a contagem de quem já foi ajustado.

do $ajuste$
declare
  uid uuid;
  sid uuid;
  iid uuid;

  -- [nome do item, modo_controle, duracao_dias, duracao_atendimentos]
  modos text[][] := array[
    -- validade por atendimentos (pote/frasco compartilhado, gasto por uso)
    ['Cola de cílios',        'validade_atendimentos', '',   '15'],
    ['Primer para cílios',    'validade_atendimentos', '',   '20'],
    ['Finalizador de cílios', 'validade_atendimentos', '',   '20'],
    ['Henna',                 'validade_atendimentos', '',   '10'],
    ['Cera quente',           'validade_atendimentos', '',   '30'],
    ['Linha para sobrancelha','validade_atendimentos', '',   '40'],
    ['Pigmento',              'validade_atendimentos', '',   '20'],
    ['Anestésico',            'validade_atendimentos', '',   '25'],
    ['Sérum facial',          'validade_atendimentos', '',   '10'],

    -- validade por dias (resseca/vence pelo tempo aberto, não pelo uso)
    ['Shampoo de limpeza (cílios)', 'validade_dias', '60', ''],
    ['Espuma de limpeza',           'validade_dias', '45', ''],
    ['Tônico facial',               'validade_dias', '45', ''],
    ['Gel hidratante',               'validade_dias', '60', ''],
    ['Óleo removedor de cera',       'validade_dias', '60', ''],
    ['Esfoliante facial',           'validade_dias', '45', ''],
    ['Máscara vulcânica',           'validade_dias', '30', ''],
    ['Emoliente',                    'validade_dias', '60', ''],
    ['Gel revitalizante',           'validade_dias', '45', '']
  ];
begin
  select user_id into uid from perfil_salao where nome_salao ilike '%Thamires%' limit 1;

  if uid is null then
    raise notice '009_ajuste_validade_produtos_padrao: perfil da Thamires não encontrado — nada ajustado.';
    return;
  end if;

  for i in 1 .. array_length(modos, 1) loop
    update estoque_itens
       set modo_controle = modos[i][2],
           duracao_dias = case when modos[i][3] = '' then null else modos[i][3]::integer end,
           duracao_atendimentos = case when modos[i][4] = '' then null else modos[i][4]::integer end,
           -- só reabre a contagem se estava em "quantidade" (nunca tinha
           -- entrado nesse modo) — não reseta quem já foi ajustado antes
           -- e rodar de novo mudou nada.
           unidade_aberta_em = case when modo_controle = 'quantidade' then now() else unidade_aberta_em end,
           atendimentos_desde_abertura = case when modo_controle = 'quantidade' then 0 else atendimentos_desde_abertura end
     where user_id = uid
       and nome = modos[i][1]
       and modo_controle <> modos[i][2];
  end loop;

  -- ----------------------------------------------------------------
  -- Link errado da 008: Rolo de jade é equipamento reutilizável (não
  -- se gasta por atendimento) — não devia estar em servico_produtos_
  -- padrao baixando saldo a cada Protocolo de reconstrução.
  -- ----------------------------------------------------------------
  select id into sid from servicos where user_id = uid and nome = 'Protocolo de reconstrução';
  if sid is not null then
    delete from servico_produtos_padrao spp
     using estoque_itens e
     where spp.servico_id = sid
       and spp.item_estoque_id = e.id
       and e.user_id = uid
       and e.nome = 'Rolo de jade';
  end if;

  -- ----------------------------------------------------------------
  -- Produtos padrão: quantidade correta nos links que a 008 já tinha
  -- criado (ex.: cola de cílios não é "1 unidade" por atendimento, é
  -- uma fração do frasco) + todos os produtos que faltavam por
  -- serviço, cobrindo a lista completa que a Thamires mandou.
  -- ----------------------------------------------------------------
  -- [nome do serviço, nome do item, quantidade usada por atendimento]
  declare
    produtos text[][] := array[
      -- Extensão de cílios
      ['Extensão de cílios', 'Cola de cílios', '0.1'],
      ['Extensão de cílios', 'Fios de cílios (diversos)', '2'],
      ['Extensão de cílios', 'Primer para cílios', '0.1'],
      ['Extensão de cílios', 'Finalizador de cílios', '0.1'],
      ['Extensão de cílios', 'Shampoo de limpeza (cílios)', '15'],
      ['Extensão de cílios', 'Papel interfolha', '1'],
      ['Extensão de cílios', 'Pad de cílios', '1'],
      ['Extensão de cílios', 'Fita japonesa', '1'],
      ['Extensão de cílios', 'Fita mágica', '1'],
      ['Extensão de cílios', 'Microbrush', '3'],
      ['Extensão de cílios', 'Pincel de batom', '1'],
      ['Extensão de cílios', 'Água', '50'],

      -- Design de sobrancelhas
      ['Design de sobrancelhas', 'Henna', '0.15'],
      ['Design de sobrancelhas', 'Cera quente', '30'],
      ['Design de sobrancelhas', 'Linha para sobrancelha', '0.05'],
      ['Design de sobrancelhas', 'Espuma de limpeza', '10'],
      ['Design de sobrancelhas', 'Tônico facial', '10'],
      ['Design de sobrancelhas', 'Gel hidratante', '5'],
      ['Design de sobrancelhas', 'Óleo removedor de cera', '8'],
      ['Design de sobrancelhas', 'Palito para cera', '2'],
      ['Design de sobrancelhas', 'Palito para henna', '1'],
      ['Design de sobrancelhas', 'Algodão', '2'],
      ['Design de sobrancelhas', 'Fita de depilação', '3'],
      ['Design de sobrancelhas', 'Esferas de sobrancelha', '1'],

      -- Limpeza de pele
      ['Limpeza de pele', 'Esfoliante facial', '10'],
      ['Limpeza de pele', 'Máscara vulcânica', '25'],
      ['Limpeza de pele', 'Gaze', '2'],
      ['Limpeza de pele', 'Máscara facial para limpeza de pele', '1'],
      ['Limpeza de pele', 'Emoliente', '10'],
      ['Limpeza de pele', 'Gel revitalizante', '10'],

      -- Micropigmentação
      ['Micropigmentação', 'Pigmento', '0.1'],
      ['Micropigmentação', 'Agulha de micropigmentação', '1'],
      ['Micropigmentação', 'Anestésico', '0.1'],
      ['Micropigmentação', 'Papel filme', '1'],

      -- Protocolo de reconstrução
      ['Protocolo de reconstrução', 'Sérum facial', '15']
    ];
  begin
    for i in 1 .. array_length(produtos, 1) loop
      select id into sid from servicos where user_id = uid and nome = produtos[i][1];
      if sid is null then
        continue;
      end if;

      select id into iid from estoque_itens where user_id = uid and nome = produtos[i][2];
      if iid is null then
        continue;
      end if;

      if exists (
        select 1 from servico_produtos_padrao
         where servico_id = sid and item_estoque_id = iid
      ) then
        update servico_produtos_padrao
           set quantidade = produtos[i][3]::numeric
         where servico_id = sid and item_estoque_id = iid;
      else
        insert into servico_produtos_padrao (servico_id, item_estoque_id, quantidade)
        values (sid, iid, produtos[i][3]::numeric);
      end if;
    end loop;
  end;
end $ajuste$;
