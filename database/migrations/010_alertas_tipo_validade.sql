-- ================================================================
-- 010. ALERTAS — tipos de validade de estoque
-- ================================================================
-- Suporte à sugestão de automação #1 (06/09/2026): `estoque_service.listar`
-- agora espelha em `alertas` o `status_validade` já calculado por item (modo
-- `validade_dias`/`validade_atendimentos`, ver 008/009) — sem isso, item com
-- validade acabando só aparecia como badge na tela de Estoque, sem chegar na
-- central de alertas/badge global. `api/app/schemas/alertas.py` (TipoAlerta)
-- já ganhou `validade_proxima`/`validade_vencida` — falta só o banco, mesmo
-- padrão da 007 (schema Python correto, constraint do banco atrasada).
-- `referencia_tipo` não muda: os dois usam `estoque_item`, já permitido.

alter table alertas drop constraint if exists alertas_tipo_check;
alter table alertas
  add constraint alertas_tipo_check
  check (tipo in (
    'estoque_negativo', 'estoque_critico', 'estoque_baixo',
    'gasto_a_vencer', 'gasto_vencido',
    'custo_fixo_a_vencer', 'custo_fixo_vencido',
    'saldo_negativo', 'zero_a_zero',
    'agendamento_publico_novo',
    'validade_proxima', 'validade_vencida'));
