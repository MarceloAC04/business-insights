import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// PostgreSQL descartável em memória. Nunca usa URL, credencial ou banco real.
const db = new PGlite();
const itemId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const outroUser = "33333333-3333-4333-8333-333333333333";
const conferir = (quantidade, dono = userId) => db.query(
  "select * from conferir_estoque($1, $2, $3, $4)",
  [itemId, quantidade, "Conferência", dono],
);

before(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table estoque_itens (
      id uuid primary key, user_id uuid not null, quantidade_atual numeric(12,3) not null,
      custo_medio numeric not null default 50, custo_ultima_compra numeric not null default 55,
      atendimentos_desde_abertura integer not null default 3
    );
    create table estoque_movimentacoes (
      id uuid primary key default gen_random_uuid(), user_id uuid not null,
      item_id uuid not null references estoque_itens(id),
      tipo text not null check (tipo in ('entrada','saida','ajuste')),
      quantidade numeric(12,3) not null check (quantidade > 0),
      motivo text not null default '', forcada boolean not null default false
    );
  `);
  const migration = await readFile(new URL("../migrations/011_conferencia_estoque.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration); // Reexecução não deve falhar nem duplicar estrutura.
});
beforeEach(async () => {
  await db.exec("truncate estoque_movimentacoes, estoque_itens");
  await db.query("insert into estoque_itens(id,user_id,quantidade_atual) values ($1,$2,6)", [itemId, userId]);
});
after(() => db.close());

for (const quantidade of [4, 0, 8, 6]) {
  test(`SQL: contagem ${quantidade} define saldo e grava anterior/atual`, async () => {
    await conferir(quantidade);
    const item = (await db.query("select * from estoque_itens")).rows[0];
    const mov = (await db.query("select * from estoque_movimentacoes")).rows[0];
    assert.equal(Number(item.quantidade_atual), quantidade);
    assert.equal(Number(item.custo_medio), 50);
    assert.equal(Number(item.custo_ultima_compra), 55);
    assert.equal(item.atendimentos_desde_abertura, 3);
    assert.equal(Number(mov.saldo_anterior), 6);
    assert.equal(Number(mov.saldo_atual), quantidade);
    assert.equal(Number(mov.quantidade), quantidade);
  });
}

test("SQL: usuário diferente não altera saldo ou histórico", async () => {
  assert.equal((await conferir(0, outroUser)).rows.length, 0);
  assert.equal((await db.query("select * from estoque_movimentacoes")).rows.length, 0);
  assert.equal(Number((await db.query("select quantidade_atual from estoque_itens")).rows[0].quantidade_atual), 6);
});

test("SQL: falha ao gravar histórico desfaz a mudança de saldo", async () => {
  await db.exec("alter table estoque_movimentacoes add constraint falhar_teste check (motivo <> 'Conferência')");
  try {
    await assert.rejects(conferir(0));
    assert.equal(Number((await db.query("select quantidade_atual from estoque_itens")).rows[0].quantidade_atual), 6);
    assert.equal((await db.query("select * from estoque_movimentacoes")).rows.length, 0);
  } finally {
    await db.exec("alter table estoque_movimentacoes drop constraint falhar_teste");
  }
});

test("SQL: zero só é aceito em ajuste; entradas e saídas continuam positivas", async () => {
  for (const tipo of ["entrada", "saida"]) {
    await assert.rejects(db.query(
      "insert into estoque_movimentacoes(user_id,item_id,tipo,quantidade) values ($1,$2,$3,0)",
      [userId, itemId, tipo],
    ));
  }
  for (const invalida of [-1, "NaN", "Infinity", "-Infinity", null]) {
    await assert.rejects(conferir(invalida));
  }
});

test("SQL: somente service_role pode executar a conferência", async () => {
  for (const papel of ["anon", "authenticated", "service_role"]) {
    const result = await db.query("select has_function_privilege($1, 'conferir_estoque(uuid,numeric,text,uuid)', 'execute') as permitido", [papel]);
    assert.equal(result.rows[0].permitido, papel === "service_role");
  }
  await db.exec("set role service_role");
  try {
    await conferir(4);
  } finally {
    await db.exec("reset role");
  }
});
