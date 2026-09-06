// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    // App e 100% client-side (nenhuma rota usa createServerFn/loader/beforeLoad) — modo "spa"
    // nativo do TanStack Start: prerenderiza um shell estatico e mascara toda rota pra ele,
    // gerando um index.html deployavel em qualquer hosting estatico (Firebase Hosting), sem
    // precisar de worker SSR.
    spa: { enabled: true },
  },
  // Sem nitro: nao precisamos do worker SSR (cloudflare-module padrao) — so do bundle client
  // gerado pelo modo spa acima.
  nitro: false,
  vite: {
    server: {
      // Permite acesso via túnel (cloudflared/ngrok) pra testar no celular —
      // o Vite recusa por padrão qualquer host que não seja localhost.
      allowedHosts: [".trycloudflare.com", ".ngrok-free.app", ".ngrok.io"],
    },
  },
});
