import type { User } from "@supabase/supabase-js";
import { ApiError, AppErrorCodes } from "../error-codes";
import { supabase } from "../supabase";
import type { Salao, Usuario } from "../types";

/**
 * `auth` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Login, logout e sessão são o próprio Supabase Auth (GoTrue): ele já
 * persiste e renova o token sozinho, em storage próprio — por isso não há
 * mais fila de refresh nem gravação manual em `AppStorage` aqui. O único
 * dado que buscamos à parte é a linha de `perfil_salao`, protegida por RLS
 * (`auth.uid() = user_id`).
 */

function usuarioDoSupabase(user: User): Usuario {
  const nome = (user.user_metadata as { nome?: string } | null)?.nome;
  return {
    id: user.id,
    nome: nome ?? user.email ?? "",
    email: user.email ?? "",
  };
}

async function buscarSalao(userId: string): Promise<Salao> {
  const { data, error } = await supabase
    .from("perfil_salao")
    .select("id, nome_salao, foto_url")
    .eq("user_id", userId)
    .single();

  // Sem policy/linha ainda (usuária nova) não é motivo pra derrubar o login —
  // mostra um salão vazio em vez de quebrar a tela.
  if (error || !data) {
    return { id: userId, nome: "Meu Salão", foto_url: null };
  }
  return {
    id: data["id"] as string,
    nome: (data["nome_salao"] as string | null) ?? "Meu Salão",
    foto_url: (data["foto_url"] as string | null) ?? null,
  };
}

export const AuthApi = {
  async login(email: string, senha: string): Promise<{ usuario: Usuario; salao: Salao }> {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: senha,
    });
    if (error || !data.user) {
      throw new ApiError(401, AppErrorCodes.invalidCredentials, "E-mail ou senha não conferem.");
    }
    const usuario = usuarioDoSupabase(data.user);
    const salao = await buscarSalao(data.user.id);
    return { usuario, salao };
  },

  async logout(): Promise<void> {
    await supabase.auth.signOut();
  },

  /** Sessão já guardada pelo Supabase (boot do app / F5) — `null` se não houver. */
  async sessaoAtual(): Promise<{ usuario: Usuario; salao: Salao } | null> {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    const usuario = usuarioDoSupabase(user);
    const salao = await buscarSalao(user.id);
    return { usuario, salao };
  },
} as const;
