-- ================================================================
-- 006. AJUSTAR_ESTOQUE — chamável também pelo backend (service_role)
-- ================================================================
-- `ajustar_estoque` (004_ajustar_estoque_rpc.sql) trava a linha com
-- `e.user_id = auth.uid()` — funciona quando quem chama é o próprio cliente
-- autenticado (branch feat/react-supabase, chave `anon` + JWT da usuária).
--
-- Na branch de integração da API (feat/api-integracao-supabase), quem chama
-- este RPC é o FastAPI com a chave `service_role`. Nessa chamada não existe
-- JWT de usuária na sessão do Postgres — `auth.uid()` volta `null`, o `where`
-- não bate nenhuma linha, e a função sempre devolve vazio (o backend já
-- validou o `sub` do token sozinho, em `usuario_atual`; é essa identidade que
-- precisa chegar até aqui).
--
-- Adiciona `p_user_id`, opcional, para o caso do backend: quando informado,
-- vale ele; quando omitido (chamada do frontend direto), cai de volta em
-- `auth.uid()` — não quebra o uso que a branch `feat/react-supabase` já faz.
--
-- `create or replace` NÃO troca a versão de 3 parâmetros por esta — assinatura
-- (nome + tipos dos parâmetros) é a identidade da função no Postgres, e um
-- parâmetro a mais é uma assinatura nova, não a mesma função com um default
-- adicional. Sem o `drop` abaixo, as duas ficariam sobrepostas e uma chamada
-- só com (p_item_id, p_delta, p_permitir_negativo) via `rpc(...)` ficaria
-- ambígua entre as duas — por isso a antiga precisa sair primeiro.
drop function if exists ajustar_estoque(uuid, numeric, boolean);

create or replace function ajustar_estoque(
  p_item_id uuid,
  p_delta numeric,
  p_permitir_negativo boolean default false,
  p_user_id uuid default null
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
    and e.user_id = coalesce(p_user_id, auth.uid())
    and (p_permitir_negativo or e.quantidade_atual + p_delta >= 0)
  returning e.id, e.quantidade_atual;
end;
$fn$;

-- `p_user_id` só pode vir de quem já validou o dono da requisição — a chave
-- `anon` (RLS/PostgREST) não deixa a usuária passar um `user_id` livre no
-- corpo do RPC porque `execute` não é concedido a ela sobre esta assinatura;
-- só `service_role` (o backend, depois de validar o JWT) e `authenticated`
-- (que não tem outro jeito de chamar isso a não ser omitindo p_user_id,
-- porque não pode se passar por outra usuária) têm grant.
revoke all on function ajustar_estoque(uuid, numeric, boolean, uuid) from public;
grant execute on function ajustar_estoque(uuid, numeric, boolean, uuid) to authenticated, service_role;
