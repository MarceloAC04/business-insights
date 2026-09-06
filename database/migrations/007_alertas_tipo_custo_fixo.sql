-- ================================================================
-- 007. ALERTAS — tipos e referencia_tipo de custo fixo
-- ================================================================
-- endpoints-backend.md §9 lista `custo_fixo_a_vencer` e `custo_fixo_vencido`
-- entre os tipos de alerta da V1, e diz que o `referencia_tipo` desses dois é
-- `custo_fixo` (o app leva para o Perfil, não para Gastos). O check constraint
-- de `alertas.tipo` (001_v1_completo.sql, atualizado por 003 só para incluir
-- `agendamento_publico_novo`) nunca ganhou os dois tipos de custo fixo, e o de
-- `referencia_tipo` nunca ganhou `custo_fixo` — hoje uma tentativa de inserir
-- qualquer um desses alertas (quando o job que os gera existir — ainda não
-- existe, é a "trilha backend" congelada) falharia com violação de check.
--
-- `api/app/schemas/alertas.py` (TipoAlerta) já lista os dois tipos desde que
-- o schema foi escrito — é o schema que está certo, o banco que ficou para
-- trás.

alter table alertas drop constraint if exists alertas_tipo_check;
alter table alertas
  add constraint alertas_tipo_check
  check (tipo in (
    'estoque_negativo', 'estoque_critico', 'estoque_baixo',
    'gasto_a_vencer', 'gasto_vencido',
    'custo_fixo_a_vencer', 'custo_fixo_vencido',
    'saldo_negativo', 'zero_a_zero',
    'agendamento_publico_novo'));

alter table alertas drop constraint if exists alertas_referencia_tipo_check;
alter table alertas
  add constraint alertas_referencia_tipo_check
  check (referencia_tipo in (
    'estoque_item', 'gasto', 'atendimento', 'kit', 'resumo', 'custo_fixo'));
