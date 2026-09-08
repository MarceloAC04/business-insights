import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

// Usa o transformador TS já instalado no projeto, sem subir o app ou acessar APIs.
const server = await createServer({ configFile: false, server: { middlewareMode: true } });
after(() => server.close());
const { DemoDatabase } = await server.ssrLoadModule("/src/lib/demo/demo-database.ts");

function cenario() {
  const db = new DemoDatabase();
  db.createItem({
    nome: "Creme de teste",
    unidade: "un",
    categoria: "outro",
    quantidade_atual: 6,
    custo_unitario: 50,
  });
  const item = () => db.getItens().result.itens.find((p) => p.nome === "Creme de teste");
  const movimentar = (body) => db.createMovimentacao(item().id, body);
  return { db, item, movimentar };
}

for (const quantidade of [4, 0, 8, 6]) {
  test(`contagem ${quantidade} define o saldo absoluto e preserva custo`, () => {
    const { db, item, movimentar } = cenario();
    movimentar({ tipo: "ajuste", quantidade, motivo: "Conferência" });
    assert.equal(item().quantidade_atual, quantidade);
    assert.equal(item().custo_medio, 50);
    assert.equal(item().custo_ultima_compra, 50);
    const movimento = db.getMovimentacoes(item().id).result.movimentacoes[0];
    assert.equal(movimento.saldo_anterior, 6);
    assert.equal(movimento.saldo_atual, quantidade);
    assert.equal(movimento.quantidade, quantidade);
  });
}

test("compra soma e saída subtrai, sem substituir o saldo", () => {
  const { item, movimentar } = cenario();
  movimentar({ tipo: "entrada", quantidade: 2, custo_unitario: 70 });
  assert.equal(item().quantidade_atual, 8);
  assert.equal(item().custo_medio, 55);
  movimentar({ tipo: "saida", quantidade: 3 });
  assert.equal(item().quantidade_atual, 5);
  assert.equal(item().custo_medio, 55);
});

test("saída sem saldo não altera estoque ou histórico", () => {
  const { db, item, movimentar } = cenario();
  const antes = db.getMovimentacoes(item().id).result.movimentacoes.length;
  assert.throws(() => movimentar({ tipo: "saida", quantidade: 7 }), {
    codigo: "ESTOQUE_INSUFICIENTE",
  });
  assert.equal(item().quantidade_atual, 6);
  assert.equal(db.getMovimentacoes(item().id).result.movimentacoes.length, antes);
});

test("rendimento mostra capacidade em usos e baixa uma fração da embalagem no atendimento", () => {
  const db = new DemoDatabase();
  db.createItem({
    nome: "Creme por usos",
    unidade: "un",
    categoria: "outro",
    quantidade_atual: 6,
    quantidade_minima: 0,
    custo_unitario: 50,
    modo_controle: "rendimento_usos",
    usos_por_unidade: 10,
    usos_minimos: 10,
  });
  const item = () => db.getItens().result.itens.find((p) => p.nome === "Creme por usos");

  assert.equal(item().usos_disponiveis, 60);
  assert.equal(item().custo_por_uso, 5);
  assert.equal(item().status_rendimento, "ok");

  db.createAtendimento({
    cliente_nome: "Cliente rendimento",
    data: new Date().toISOString(),
    servicos: [{ nome: "Teste", preco: 100 }],
  });
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - 1);
  const fim = new Date();
  fim.setDate(fim.getDate() + 1);
  const atendimento = db
    .getAtendimentos(inicio, fim)
    .result.atendimentos.find((atual) => atual.cliente_nome === "Cliente rendimento");

  db.finalizarAtendimento(atendimento.id, {
    materiais: [{ item_estoque_id: item().id, quantidade: 1 }],
    confirmar_estoque_insuficiente: false,
  });

  assert.equal(item().quantidade_atual, 5.9);
  assert.equal(item().usos_disponiveis, 59);
  const fechado = db.getAtendimento(atendimento.id).result;
  assert.equal(fechado.total_materiais, 5);
  assert.equal(fechado.materiais[0].unidade_consumo, "uso");
  const movimento = db.getMovimentacoes(item().id).result.movimentacoes[0];
  assert.equal(movimento.quantidade, 0.1);
  assert.equal(movimento.quantidade_consumida, 1);
  assert.equal(movimento.unidade_consumo, "uso");
});

for (const body of [
  { tipo: "entrada", quantidade: 0 },
  { tipo: "saida", quantidade: 0 },
  { tipo: "ajuste", quantidade: -1 },
  { tipo: "ajuste", quantidade: NaN },
  { tipo: "ajuste", quantidade: Infinity },
  { tipo: "ajuste", quantidade: "" },
  { tipo: "ajuste", quantidade: "   " },
  { tipo: "ajuste" },
  { tipo: "entrada", quantidade: 2, custo_unitario: -5 },
]) {
  test(`movimentação inválida não grava: ${JSON.stringify(body)}`, () => {
    const { db, item, movimentar } = cenario();
    const antes = db.getMovimentacoes(item().id).result.movimentacoes.length;
    assert.throws(() => movimentar(body), { codigo: "VALIDACAO_INVALIDA" });
    assert.equal(item().quantidade_atual, 6);
    assert.equal(db.getMovimentacoes(item().id).result.movimentacoes.length, antes);
  });
}
