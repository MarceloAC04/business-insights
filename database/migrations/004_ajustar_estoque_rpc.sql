-- ================================================================
-- 004. AJUSTAR_ESTOQUE — único RPC do app (branch feat/react-supabase)
-- ================================================================
-- Todo o resto do frontend fala direto com o PostgREST (select/insert/update
-- simples). Mas "somar um delta ao saldo" não dá para fazer em client puro
-- sem ler o valor antes — e entre o `select` e o `update` existe uma janela
-- onde outra finalização do mesmo item pode escrever por cima (dado
-- perdido). PostgREST também não aceita `quantidade_atual = quantidade_atual
-- + delta` no corpo do update — só valor literal.
--
-- Esta função é a única exceção: um `update` de uma linha só, com a conta e
-- a trava no mesmo statement, atômico por natureza do Postgres. Usada por
-- `AtendimentosApi.finalizar/cancelar` (A5 — duas passadas, saldo pode ficar
-- negativo só quando `p_permitir_negativo`) e depois por `estoque`/`kits`
-- quando chegar a vez desses módulos.
--
-- Devolve null quando a trava impediu o update (saldo insuficiente e
-- `permitir_negativo = false`) — o chamador decide o que fazer (409, ou
-- juntar no `faltantes`).

create or replace function ajustar_estoque(
  p_item_id uuid,
  p_delta numeric,
  p_permitir_negativo boolean default false
)
returns table(id uuid, quantidade_atual numeric)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
  update estoque_itens e
  set quantidade_atual = e.quantidade_atual + p_delta
  where e.id = p_item_id
    and e.user_id = auth.uid()
    and (p_permitir_negativo or e.quantidade_atual + p_delta >= 0)
  returning e.id, e.quantidade_atual;
end;
$fn$;

-- `security definer` roda com dono da função, não com o papel de quem chama —
-- por isso o `e.user_id = auth.uid()` dentro do próprio `where` é quem faz o
-- papel que a RLS faria: sem ele, qualquer usuária autenticada ajustaria
-- estoque de qualquer outra.
revoke all on function ajustar_estoque(uuid, numeric, boolean) from public;
grant execute on function ajustar_estoque(uuid, numeric, boolean) to authenticated;
