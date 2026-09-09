import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true } });
after(() => server.close());
const push = await server.ssrLoadModule("/src/lib/web-push.ts");
const { AppEnvironment } = await server.ssrLoadModule("/src/lib/env.ts");
const { ApiError } = await server.ssrLoadModule("/src/lib/error-codes.ts");
const originalKey = AppEnvironment.webPushPublicKey;
const globals = new Map(
  ["window", "navigator", "Notification"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
let subscriptions;
let permissions;
let subscription;
let subscribe;

beforeEach(() => {
  subscriptions = 0;
  permissions = 0;
  subscription = null;
  subscribe = async () => ({ endpoint: "https://push.example.test/subscription" });
  AppEnvironment.webPushPublicKey = Buffer.alloc(65, 4).toString("base64url");
  const notification = {
    permission: "granted",
    async requestPermission() {
      permissions += 1;
      return notification.permission;
    },
  };
  const registration = {
    pushManager: {
      async getSubscription() {
        return subscription;
      },
      async subscribe() {
        subscriptions += 1;
        return subscribe();
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { isSecureContext: true, Notification: notification, PushManager: {}, atob },
  });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: notification });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        register: async () => registration,
        ready: Promise.resolve(registration),
      },
    },
  });
});

afterEach(() => {
  AppEnvironment.webPushPublicKey = originalKey;
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

test("ao entrar no app reutiliza a assinatura, sem criar inscrição em segundo plano", async () => {
  assert.equal(await push.obterAssinaturaWebPush(false), null);
  assert.equal(subscriptions, 0);
  subscription = { endpoint: "https://push.example.test/existing" };
  assert.equal(await push.obterAssinaturaWebPush(false), subscription);
  assert.equal(subscriptions, 0);
  assert.equal(permissions, 0);
});

test("cliques simultâneos compartilham uma única inscrição no navegador", async () => {
  let finish;
  subscribe = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = push.obterAssinaturaWebPush(true);
  const second = push.obterAssinaturaWebPush(true);
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscriptions, 1);
  const result = { endpoint: "https://push.example.test/created" };
  finish(result);
  assert.deepEqual(await Promise.all([first, second]), [result, result]);
});

test("falha real do serviço é traduzida e permite tentar de novo", async () => {
  const failure = new DOMException("Registration failed - push service error", "AbortError");
  subscribe = async () => {
    throw failure;
  };
  await assert.rejects(push.obterAssinaturaWebPush(true), (error) => error === failure);
  assert.match(push.textoDoErroPush(failure), /serviço de notificações do navegador/);
  assert.doesNotMatch(push.textoDoErroPush(failure), /Registration failed/);
  subscribe = async () => ({ endpoint: "https://push.example.test/recovered" });
  assert.ok(await push.obterAssinaturaWebPush(true));
  assert.equal(subscriptions, 2);
});

test("permissão negada ou adiada não inicia inscrição", async () => {
  Notification.permission = "denied";
  assert.equal(await push.obterAssinaturaWebPush(true), null);
  Notification.permission = "default";
  assert.equal(await push.obterAssinaturaWebPush(false), null);
  assert.equal(permissions, 0);
  assert.equal(await push.obterAssinaturaWebPush(true), null);
  assert.equal(permissions, 1);
  assert.equal(subscriptions, 0);
});

test("distingue indisponibilidade da API de falha do navegador e não vaza erro bruto", () => {
  const serverError = new ApiError(503, null, "internal server details");
  assert.match(push.textoDoErroPush(serverError), /servidor/);
  assert.doesNotMatch(push.textoDoErroPush(new Error("internal browser details")), /internal/);
  assert.match(push.textoDoErroPush(new DOMException("denied", "NotAllowedError")), /permissão/);
});

test("não oferece push em contexto inseguro", async () => {
  window.isSecureContext = false;
  assert.equal(push.webPushDisponivel(), false);
  assert.equal(await push.obterAssinaturaWebPush(true), null);
  assert.equal(subscriptions, 0);
});
