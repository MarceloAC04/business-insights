-- ================================================================
-- 013. ENCERRAMENTO DOS CONTROLES LEGADOS DE DURAÇÃO
-- ================================================================
-- Etapa 3 do roadmap de estoque (07/09/2026).
--
-- O produto não vence nem é descartado porque passou certo número de dias ou
-- atendimentos. `rendimento_usos` é usado quando há uma capacidade conhecida;
-- o restante continua como saldo físico em `quantidade` até uma conferência
-- informar outra base. Assim não inventamos quantos potes há em ml/g/caixa e
-- não alteramos composições de kits ou históricos.
--
-- Aplicar depois de 012. É idempotente e não apaga dados históricos: as
-- colunas antigas permanecem nulas por compatibilidade, e apenas alertas
-- ativos de validade são resolvidos para não continuar aparecendo à usuária.

begin;

-- Os poucos itens que 012 não podia converter com segurança (ml/g/caixa ou
-- vinculados a kit) continuam com o mesmo saldo e custo, agora em controle
-- físico. Também limpa qualquer configuração de rendimento residual.
update public.estoque_itens
   set modo_controle = 'quantidade',
       usos_por_unidade = null,
       usos_minimos = 0
 where modo_controle in ('validade_dias', 'validade_atendimentos');

-- Itens já convertidos para rendimento podem carregar o número legado em
-- `duracao_atendimentos`; ele não é mais uma fonte de regra de negócio.
update public.estoque_itens
   set duracao_dias = null,
       duracao_atendimentos = null,
       unidade_aberta_em = null,
       atendimentos_desde_abertura = 0;

alter table public.estoque_itens
  drop constraint if exists estoque_itens_modo_controle_check;
alter table public.estoque_itens
  add constraint estoque_itens_modo_controle_check
  check (modo_controle in ('quantidade', 'rendimento_usos'));

-- Alertas resolvidos continuam guardados como histórico, mas não entram mais
-- na central nem no badge. Novas ocorrências não são mais geradas pela API.
update public.alertas
   set resolvido_em = coalesce(resolvido_em, now())
 where resolvido_em is null
   and chave_dedupe like 'validade:%';

commit;
