-- Etapa 1 do roadmap: conferência define o saldo contado, inclusive zero.
-- Aplicar antes de publicar o backend. Idempotente e sem reescrever histórico.
begin;

alter table public.estoque_movimentacoes
  add column if not exists saldo_anterior numeric(12, 3),
  add column if not exists saldo_atual numeric(12, 3);

alter table public.estoque_movimentacoes
  drop constraint if exists estoque_movimentacoes_quantidade_check;
alter table public.estoque_movimentacoes
  add constraint estoque_movimentacoes_quantidade_check
  check (quantidade > 0 or (tipo = 'ajuste' and quantidade = 0));

create or replace function public.conferir_estoque(
  p_item_id uuid,
  p_quantidade numeric,
  p_motivo text,
  p_user_id uuid
)
returns table(id uuid, quantidade_atual numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  saldo_antes numeric(12, 3);
  saldo_contado numeric(12, 3);
begin
  if p_quantidade is null or p_quantidade < 0
     or p_quantidade::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'A quantidade contada deve ser finita e não negativa'
      using errcode = '22023';
  end if;
  saldo_contado := p_quantidade;

  select e.quantidade_atual into saldo_antes
    from public.estoque_itens e
    where e.id = p_item_id and e.user_id = p_user_id
    for update;
  if not found then
    return;
  end if;

  update public.estoque_itens e
    set quantidade_atual = saldo_contado
    where e.id = p_item_id and e.user_id = p_user_id;

  insert into public.estoque_movimentacoes
    (user_id, item_id, tipo, quantidade, motivo, forcada, saldo_anterior, saldo_atual)
    values (p_user_id, p_item_id, 'ajuste', saldo_contado,
            coalesce(p_motivo, ''), false, saldo_antes, saldo_contado);

  return query select p_item_id, saldo_contado;
end;
$fn$;

-- Somente FastAPI/service_role pode fornecer o dono, após validar o JWT.
revoke all on function public.conferir_estoque(uuid, numeric, text, uuid)
  from public, anon, authenticated;
grant execute on function public.conferir_estoque(uuid, numeric, text, uuid)
  to service_role;

commit;
