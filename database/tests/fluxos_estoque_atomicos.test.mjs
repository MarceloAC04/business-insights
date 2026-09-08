import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  atendimento: "22222222-2222-4222-8222-222222222222",
  atendimentoFalha: "22222222-2222-4222-8222-222222222223",
  itemA: "33333333-3333-4333-8333-333333333333",
  itemB: "33333333-3333-4333-8333-333333333334",
  itemFalha: "33333333-3333-4333-8333-333333333335",
  servico: "44444444-4444-4444-8444-444444444444",
  kit: "55555555-5555-4555-8555-555555555555",
};

async function rpc(name, params) {
  return (await db.query(`select ${name}(${Object.keys(params).map((_, i) => `$${i + 1}`).join(", ")}) as result`, Object.values(params))).rows[0].result;
}

before(async () => {
  await db.exec(`
    create role service_role;
    create table estoque_itens (
      id uuid primary key, user_id uuid not null, nome text not null, unidade text not null,
      quantidade_atual numeric not null, quantidade_minima numeric not null default 0,
      custo_medio numeric not null default 0, modo_controle text not null default 'quantidade',
      usos_por_unidade numeric
    );
    create table atendimentos (
      id uuid primary key, user_id uuid not null, status text not null,
      finalizado_em timestamptz, cancelado_em timestamptz
    );
    create table atendimento_insumos (
      id uuid primary key default gen_random_uuid(), atendimento_id uuid not null,
      item_estoque_id uuid, nome text not null check (nome <> 'falhar'), quantidade numeric not null,
      preco numeric not null, unidade_consumo text
    );
    create table atendimento_servicos (
      id uuid primary key default gen_random_uuid(), atendimento_id uuid not null,
      servico_id uuid, custo_insumos_snapshot numeric not null default 0
    );
    create table servico_produtos_padrao (
      servico_id uuid not null, item_estoque_id uuid not null, quantidade numeric not null
    );
    create table estoque_movimentacoes (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, item_id uuid not null,
      tipo text not null, quantidade numeric not null, quantidade_consumida numeric,
      unidade_consumo text, motivo text not null, custo_unitario numeric, atendimento_id uuid,
      kit_id uuid, forcada boolean not null default false
    );
    create table alertas (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, tipo text not null,
      severidade text not null, titulo text not null, mensagem text not null, referencia_tipo text,
      referencia_id uuid, chave_dedupe text not null, resolvido_em timestamptz
    );
    create table kits (
      id uuid primary key, user_id uuid not null, nome text not null, preco_venda numeric not null,
      quantidade_montada numeric not null default 0
    );
    create table kit_itens (kit_id uuid not null, item_estoque_id uuid not null, quantidade numeric not null);
    create table kit_vendas (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, kit_id uuid not null,
      quantidade numeric not null, nome_snapshot text not null, preco_unitario numeric not null,
      custo_snapshot numeric not null, forma_pagamento text not null, data timestamptz not null
    );
  `);
  const migration = await readFile(new URL("../migrations/014_fluxos_estoque_atomicos.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.query(
    `insert into estoque_itens(id,user_id,nome,unidade,quantidade_atual,custo_medio,modo_controle,usos_por_unidade)
     values ($1,$2,'Creme','un',6,50,'rendimento_usos',10),
            ($3,$2,'Pad','un',10,2,'quantidade',null),
            ($4,$2,'Falha','un',3,4,'quantidade',null)`,
    [ids.itemA, ids.user, ids.itemB, ids.itemFalha],
  );
  await db.query("insert into atendimentos(id,user_id,status) values ($1,$2,'agendado'),($3,$2,'agendado')", [ids.atendimento, ids.user, ids.atendimentoFalha]);
  await db.query("insert into atendimento_servicos(atendimento_id,servico_id) values ($1,$2)", [ids.atendimento, ids.servico]);
  await db.query("insert into servico_produtos_padrao(servico_id,item_estoque_id,quantidade) values ($1,$2,1)", [ids.servico, ids.itemA]);
  await db.query("insert into kits(id,user_id,nome,preco_venda,quantidade_montada) values ($1,$2,'Kit cuidado',40,0)", [ids.kit, ids.user]);
  await db.query("insert into kit_itens(kit_id,item_estoque_id,quantidade) values ($1,$2,2)", [ids.kit, ids.itemB]);
});

after(() => db.close());

test("SQL: finalização baixa uma vez, e o estorno devolve uma vez", async () => {
  const materiais = JSON.stringify([{ item_estoque_id: ids.itemA, quantidade: 1 }]);
  assert.equal((await rpc("finalizar_atendimento_estoque", {
    atendimento: ids.atendimento, user: ids.user, materiais, confirmar: false,
  })).codigo, "OK");
  assert.equal(Number((await db.query("select quantidade_atual from estoque_itens where id=$1", [ids.itemA])).rows[0].quantidade_atual), 5.9);
  assert.equal((await rpc("finalizar_atendimento_estoque", {
    atendimento: ids.atendimento, user: ids.user, materiais, confirmar: false,
  })).codigo, "ATENDIMENTO_STATUS_INVALIDO");
  assert.equal(Number((await db.query("select count(*) as total from estoque_movimentacoes where atendimento_id=$1", [ids.atendimento])).rows[0].total), 1);

  assert.equal((await rpc("cancelar_atendimento_estoque", { atendimento: ids.atendimento, user: ids.user })).codigo, "OK");
  assert.equal(Number((await db.query("select quantidade_atual from estoque_itens where id=$1", [ids.itemA])).rows[0].quantidade_atual), 6);
  assert.equal((await rpc("cancelar_atendimento_estoque", { atendimento: ids.atendimento, user: ids.user })).codigo, "ATENDIMENTO_STATUS_INVALIDO");
  assert.equal(Number((await db.query("select count(*) as total from estoque_movimentacoes where atendimento_id=$1", [ids.atendimento])).rows[0].total), 2);
});

test("SQL: estoque insuficiente e falha de gravação não deixam baixa parcial", async () => {
  const insuficiente = await rpc("finalizar_atendimento_estoque", {
    atendimento: ids.atendimentoFalha,
    user: ids.user,
    materiais: JSON.stringify([{ item_estoque_id: ids.itemB, quantidade: 12 }]),
    confirmar: false,
  });
  assert.equal(insuficiente.codigo, "ESTOQUE_INSUFICIENTE");
  assert.equal(Number((await db.query("select quantidade_atual from estoque_itens where id=$1", [ids.itemB])).rows[0].quantidade_atual), 10);

  await db.exec(`alter table estoque_movimentacoes add constraint falha_historico check (item_id <> '${ids.itemFalha}'::uuid)`);
  await assert.rejects(rpc("finalizar_atendimento_estoque", {
    atendimento: ids.atendimentoFalha,
    user: ids.user,
    materiais: JSON.stringify([{ item_estoque_id: ids.itemFalha, quantidade: 1 }]),
    confirmar: false,
  }));
  assert.equal(Number((await db.query("select quantidade_atual from estoque_itens where id=$1", [ids.itemFalha])).rows[0].quantidade_atual), 3);
  assert.equal((await db.query("select status from atendimentos where id=$1", [ids.atendimentoFalha])).rows[0].status, "agendado");
});

test("SQL: montar baixa insumos; vender usa apenas saldo montado", async () => {
  assert.equal((await rpc("montar_kit_estoque", {
    kit: ids.kit, user: ids.user, quantidade: 2, confirmar: false,
  })).codigo, "OK");
  assert.equal(Number((await db.query("select quantidade_atual from estoque_itens where id=$1", [ids.itemB])).rows[0].quantidade_atual), 6);
  assert.equal((await rpc("vender_kit_estoque", {
    kit: ids.kit, user: ids.user, quantidade: 1, preco: null, forma: "pix", data: null,
  })).codigo, "OK");
  assert.equal(Number((await db.query("select quantidade_montada from kits where id=$1", [ids.kit])).rows[0].quantidade_montada), 1);
  assert.equal(Number((await db.query("select quantidade_atual from estoque_itens where id=$1", [ids.itemB])).rows[0].quantidade_atual), 6);
});
