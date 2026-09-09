import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true } });
after(() => server.close());
const { formatMoedaInput, LIMITE_VALOR_INPUT, pluralizar } = await server.ssrLoadModule(
  "/src/lib/format.ts",
);

test("limita qualquer valor monetário digitado a um milhão", () => {
  assert.equal(LIMITE_VALOR_INPUT, 1_000_000);
  assert.equal(formatMoedaInput("100000000"), "1.000.000,00");
  assert.equal(formatMoedaInput("100000001"), "1.000.000,00");
  assert.equal(formatMoedaInput("R$ 1.500.000,00"), "1.000.000,00");
});

test("usa singular somente para a quantidade 1", () => {
  assert.equal(pluralizar(1, "produto"), "produto");
  assert.equal(pluralizar(0, "produto"), "produtos");
  assert.equal(pluralizar(2, "produto"), "produtos");
  assert.equal(pluralizar(1, "embalagem"), "embalagem");
  assert.equal(pluralizar(2, "embalagem"), "embalagens");
  assert.equal(pluralizar(1, "mês"), "mês");
  assert.equal(pluralizar(2, "mês"), "meses");
});
