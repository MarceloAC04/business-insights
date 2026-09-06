import { AppApi } from "../http";
import { AppStorage } from "../storage";
import type { Salao, Sessao, Usuario } from "../types";
import { Paths } from "./paths";

/**
 * `auth` — 4 operações (§1 do contrato).
 *
 * É o único módulo que escreve no `AppStorage`: quem guarda e apaga a sessão é
 * daqui, não a tela de login. O refresh automático vive no transporte
 * (`http.ts`).
 */
export const AuthApi = {
  /** Login não leva bearer: a credencial é o próprio corpo. */
  async login(email: string, senha: string): Promise<{ usuario: Usuario; salao: Salao }> {
    const { result } = await AppApi.postSemToken<Sessao>(Paths.login, { email, senha });
    AppStorage.salvarSessao(result);
    return { usuario: result.usuario, salao: result.salao };
  },

  /**
   * Avisa o servidor e limpa a sessão local.
   *
   * A falha da chamada não impede a saída: se ela clicou em "sair", sair é o
   * que tem que acontecer — token inválido no servidor é problema do servidor.
   */
  async logout(): Promise<void> {
    try {
      await AppApi.post(Paths.logout);
    } finally {
      AppStorage.limpar();
    }
  },

  /**
   * Sessão guardada localmente (boot do app / F5), revalidada contra o
   * servidor. `null` quando não há token guardado ou quando a revalidação
   * falha (token/refresh inválidos) — o transporte já derruba a sessão local
   * nesse caso, então aqui só resta devolver `null` para o guard de rota.
   */
  async sessaoAtual(): Promise<{ usuario: Usuario; salao: Salao } | null> {
    if (!AppStorage.autenticado) return null;
    try {
      const { result } = await AppApi.get<{ usuario: Usuario; salao: Salao }>(Paths.eu);
      return result;
    } catch {
      return null;
    }
  },
} as const;
