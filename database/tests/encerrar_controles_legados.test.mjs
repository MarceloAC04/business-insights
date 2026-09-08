import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Banco PostgreSQL descartável em memória. Não usa URL, credencial ou Supabase.
const db = new PGlite();
const userId = "22222222-2222-4222-8222-222222222222";
const itemUso = "11111111-1111-4111-8111-111111111111";
const itemMl = "11111111-1111-4111-8111-111111111112";
const itemKit = "11111111-1111-4111-8111-111111111113";

before(async () => {
  await db.exec(`
    create table estoque_itens (
      id uuid primary key,
      user_id uuid not null,
      unidade text not null,
      modo_controle text not null default 'quantidade',
      duracao_dias integer,
      duracao_atendimentos integer,
      unidade_aberta_em timestamptz,
      atendimentos_desde_abertura integer not null default 0,
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
    create table alertas (
      id uuid primary key default gen_random_uuid(),
      chave_dedupe text not null,
      resolvido_em timestamptz
    );
  `);
  await db.query(
    `insert into estoque_itens
       (id, user_id, unidade, modo_controle, duracao_dias, duracao_atendimentos,
        unidade_aberta_em, atendimentos_desde_abertura, quantidade_atual, custo_medio)
     values
       ($1, $4, 'un', 'validade_atendimentos', null, 10, now(), 4, 6, 50),
       ($2, $4, 'ml', 'validade_atendimentos', null, 10, now(), 2, 100, 0.5),
       ($3, $4, 'un', 'validade_dias', 30, null, now(), 1, 2, 20)`,
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
  await db.query("insert into alertas(chave_dedupe) values ('validade:teste')");

  const migration012 = await readFile(
    new URL("../migrations/012_rendimento_por_usos.sql", import.meta.url),
    "utf8",
  );
  const migration013 = await readFile(
    new URL("../migrations/013_encerrar_controles_legados.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration012);
  await db.exec(migration013);
  await db.exec(migration013);
});

after(() => db.close());

test("SQL: encerra validade sem inventar rendimento e sem deixar alerta ativo", async () => {
  const itens = (await db.query("select * from estoque_itens order by id")).rows;
  const [uso, ml, kit] = itens;
  const produto = (await db.query("select quantidade from servico_produtos_padrao")).rows[0];
  const composicaoKit = (await db.query("select quantidade from kit_itens")).rows[0];
  const alerta = (await db.query("select resolvido_em from alertas")).rows[0];

  assert.equal(uso.modo_controle, "rendimento_usos");
  assert.equal(Number(uso.usos_por_unidade), 10);
  assert.equal(Number(uso.quantidade_atual) * Number(uso.usos_por_unidade), 60);
  assert.equal(Number(produto.quantidade), 1);

  assert.equal(ml.modo_controle, "quantidade");
  assert.equal(Number(ml.quantidade_atual), 100);
  assert.equal(ml.usos_por_unidade, null);
  assert.equal(kit.modo_controle, "quantidade");
  assert.equal(Number(kit.quantidade_atual), 2);
  assert.equal(Number(composicaoKit.quantidade), 1);

  for (const item of itens) {
    assert.equal(item.duracao_dias, null);
    assert.equal(item.duracao_atendimentos, null);
    assert.equal(item.unidade_aberta_em, null);
    assert.equal(item.atendimentos_desde_abertura, 0);
  }
  assert.notEqual(alerta.resolvido_em, null);

  await assert.rejects(
    db.query("update estoque_itens set modo_controle = 'validade_dias' where id = $1", [itemMl]),
  );
});
