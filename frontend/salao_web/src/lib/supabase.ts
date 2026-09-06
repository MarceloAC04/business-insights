import { createClient } from "@supabase/supabase-js";

/**
 * Cliente único do Supabase — equivalente ao antigo `AppApi` (lib/http.ts),
 * mas sem FastAPI no meio (decisão que substitui A1, ver conversa que levou
 * à branch `feat/react-supabase`).
 *
 * Usa a chave `anon`: nunca a `service_role`. Toda autorização é imposta
 * pelas policies de RLS no Postgres, chaveadas em `auth.uid()` — não existe
 * aqui um `user_id` que o cliente escolha.
 *
 * O client já persiste e renova a sessão sozinho (localStorage próprio,
 * fora do `AppStorage`) — não precisa reimplementar fila de refresh como o
 * `lib/http.ts` fazia para o bearer do FastAPI.
 */
const supabaseUrl = import.meta.env["VITE_SUPABASE_URL"];
const supabaseAnonKey = import.meta.env["VITE_SUPABASE_ANON_KEY"];

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY precisam estar definidas no .env",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
