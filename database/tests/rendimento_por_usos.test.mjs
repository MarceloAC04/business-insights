import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Banco PostgreSQL em memória. Não há URL, credencial ou acesso ao Supabase.
const db = new PGlite();
const userId = "22222222-2222-4222-8222-222222222222";
const itemUso = "11111111-1111-4111-8111-111111111111";
const itemMl = "11111111-1111-4111-8111-111111111112";
const itemKit = "11111111-1111-4111-8111-111111111113";
let migration = "";

before(async () => {
  await db.exec(`
    create table estoque_itens (
      id uuid primary key,
      user_id uuid not null,
      unidade text not null,
      modo_controle text not null default 'quantidade',
      duracao_atendimentos integer,
      quantidade_atual numeric(12,3) not null default 0,
      custo_medio numeric not null default 0,
      quantidade_minima numeric(12,3) not null default 0,
      constraint estoque_itens_modo_controle_check
        check (modo_controle in ('quantidade', 'validade_dias', 'validade_atendimentos'))
    );
    create table servico_produtos_padrao (
      servico_id uuid not null,
      item_estoque_id uuid not null references estoque_itens(id),
      quantidade numeric(12,3) not null
    );
    create table kit_itens (
      kit_id uuid not null,
      item_estoque_id uuid not null references estoque_itens(id),
      quantidade numeric(12,3) not null
    );
    create table estoque_movimentacoes (
      id uuid primary key default gen_random_uuid(),
      item_id uuid not null references estoque_itens(id),
      quantidade numeric(12,3) not null
    );
    create table atendimento_insumos (
      id uuid primary key default gen_random_uuid(),
      item_estoque_id uuid references estoque_itens(id),
      quantidade numeric(12,3) not null
    );
  `);
  migration = await readFile(
    new URL("../migrations/012_rendimento_por_usos.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
});

beforeEach(async () => {
  await db.exec(
    "truncate servico_produtos_padrao, kit_itens, estoque_movimentacoes, atendimento_insumos, estoque_itens",
  );
  await db.query(
    `insert into estoque_itens
       (id, user_id, unidade, modo_controle, duracao_atendimentos, quantidade_atual, custo_medio)
     values
       ($1, $4, 'un', 'validade_atendimentos', 10, 6, 50),
       ($2, $4, 'ml', 'validade_atendimentos', 10, 100, 0.5),
       ($3, $4, 'un', 'validade_atendimentos', 10, 2, 20)`,
    [itemUso, itemMl, itemKit, userId],
  );
  await db.query(
    "insert into servico_produtos_padrao(servico_id,item_estoque_id,quantidade) values ($1,$2,0.1)",
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", itemUso],
  );
  await db.query(
    "insert into kit_itens(kit_id,item_estoque_id,quantidade) values ($1,$2,1)",
    ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", itemKit],
  );
  // Roda a migração real sobre dados legados; a repetição no `before` já
  // comprovou que a estrutura também pode ser aplicada em banco vazio.
  await db.exec(migration);
});

after(() => db.close());

test("SQL: converte pote em unidade para capacidade em usos e preserva custo", async () => {
  const item = (
    await db.query("select * from estoque_itens where id = $1", [itemUso])
  ).rows[0];
  const produto = (
    await db.query("select quantidade from servico_produtos_padrao where item_estoque_id = $1", [itemUso])
  ).rows[0];

  assert.equal(item.modo_controle, "rendimento_usos");
  assert.equal(Number(item.usos_por_unidade), 10);
  assert.equal(Number(item.usos_minimos), 3);
  assert.equal(Number(item.quantidade_atual) * Number(item.usos_por_unidade), 60);
  assert.equal(Number(produto.quantidade), 1);
  assert.equal(Number(produto.quantidade) * (Number(item.custo_medio) / Number(item.usos_por_unidade)), 5);
});

test("SQL: não inventa conversão para ml nem altera composição de kit físico", async () => {
  const ml = (await db.query("select modo_controle, usos_por_unidade from estoque_itens where id = $1", [itemMl])).rows[0];
  const kit = (await db.query("select modo_controle, usos_por_unidade from estoque_itens where id = $1", [itemKit])).rows[0];

  assert.equal(ml.modo_controle, "validade_atendimentos");
  assert.equal(ml.usos_por_unidade, null);
  assert.equal(kit.modo_controle, "validade_atendimentos");
  assert.equal(kit.usos_por_unidade, null);
});

test("SQL: rendimento exige usos positivos e limite não negativo", async () => {
  await assert.rejects(
    db.query("update estoque_itens set usos_por_unidade = 0 where id = $1", [itemUso]),
  );
  await assert.rejects(
    db.query("update estoque_itens set usos_minimos = -1 where id = $1", [itemUso]),
  );
});
