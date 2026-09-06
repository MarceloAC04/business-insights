import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { AlertasPagina, PreferenciasAlerta, SeveridadeAlerta, TipoAlerta } from "../types";

/**
 * `alertas` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Diferente de todo módulo anterior: aqui **não existe cálculo nenhum para
 * fazer** — nem no cliente, nem, por enquanto, em lugar nenhum. `alertas` é
 * tabela pronta (`database/migrations/001_v1_completo.sql` §7): quem decide o
 * que vira alerta (S7) é um job que ainda não existe (cron/n8n, backend
 * F4) — o mesmo motivo pelo qual o app nunca varreu lista procurando
 * `quantidade <= minima`. Esta tela só lê o que já está lá, marca como lido e
 * mexe nas preferências e nos dispositivos — nunca gera nem apaga alerta por
 * conta própria.
 *
 * `alerta_preferencias` guarda os canais como colunas booleanas
 * (`canal_in_app`, `canal_push`, ...), diferente do formato aninhado
 * (`canais.in_app.ativo`) que a tela usa — mesmo tipo de mapeamento já visto
 * em `perfil`.
 */

interface AlertaPreferenciasRow {
  limite_saldo_alerta: number;
  dias_antecedencia_vencimento: number;
  canal_in_app: boolean;
  canal_push: boolean;
  canal_whatsapp: boolean;
  canal_email: boolean;
  tipos_silenciados: string[];
}

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

async function usuarioAtual(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");
  return userId;
}

function paraPreferencias(row: AlertaPreferenciasRow): PreferenciasAlerta {
  return {
    limite_saldo_alerta: Number(row.limite_saldo_alerta),
    dias_antecedencia_vencimento: Number(row.dias_antecedencia_vencimento),
    canais: {
      in_app: { ativo: row.canal_in_app },
      push: { ativo: row.canal_push },
      whatsapp: { ativo: row.canal_whatsapp },
      email: { ativo: row.canal_email },
    },
    tipos_silenciados: (row.tipos_silenciados ?? []) as TipoAlerta[],
  };
}

export const AlertasApi = {
  /** `resumo` é a contagem por severidade **entre os não lidos** — é o que soma no badge. */
  async listar(apenasNaoLidos?: boolean): Promise<AlertasPagina> {
    const userId = await usuarioAtual();
    let query = supabase
      .from("alertas")
      .select("id, tipo, severidade, titulo, mensagem, referencia_tipo, referencia_id, criado_em, lido_em")
      .eq("user_id", userId)
      .order("criado_em", { ascending: false });
    if (apenasNaoLidos) query = query.is("lido_em", null);

    const { data, error } = await query;
    if (error) throw erroSupabase(error);

    const alertas = (data ?? []).map((a) => ({
      id: a.id as string,
      tipo: a.tipo as TipoAlerta,
      severidade: a.severidade as SeveridadeAlerta,
      titulo: a.titulo as string,
      mensagem: a.mensagem as string,
      referencia_tipo: a.referencia_tipo as AlertasPagina["alertas"][number]["referencia_tipo"],
      referencia_id: a.referencia_id as string | null,
      criado_em: a.criado_em as string,
      lido_em: a.lido_em as string | null,
    }));

    const naoLidos = alertas.filter((a) => a.lido_em === null);
    const resumo = { critico: 0, alerta: 0, info: 0 };
    for (const a of naoLidos) {
      if (a.severidade === "critico") resumo.critico += 1;
      else if (a.severidade === "alerta") resumo.alerta += 1;
      else resumo.info += 1;
    }

    return { total_nao_lidos: naoLidos.length, resumo, alertas };
  },

  async marcarLido(id: string): Promise<void> {
    const userId = await usuarioAtual();
    const { error } = await supabase
      .from("alertas")
      .update({ lido_em: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId);
    if (error) throw erroSupabase(error);
  },

  /** `tipo` opcional marca só um recorte; sem ele, todos os não lidos. */
  async marcarTodosLidos(tipo?: TipoAlerta): Promise<void> {
    const userId = await usuarioAtual();
    let query = supabase
      .from("alertas")
      .update({ lido_em: new Date().toISOString() })
      .eq("user_id", userId)
      .is("lido_em", null);
    if (tipo) query = query.eq("tipo", tipo);
    const { error } = await query;
    if (error) throw erroSupabase(error);
  },

  async preferencias(): Promise<PreferenciasAlerta> {
    const userId = await usuarioAtual();
    const { data, error } = await supabase
      .from("alerta_preferencias")
      .select(
        "limite_saldo_alerta, dias_antecedencia_vencimento, canal_in_app, canal_push, canal_whatsapp, canal_email, tipos_silenciados",
      )
      .eq("user_id", userId)
      .single();
    if (error) throw erroSupabase(error);
    return paraPreferencias(data as unknown as AlertaPreferenciasRow);
  },

  /** PUT substitui o registro inteiro — sem diff, mesma filosofia de horário de funcionamento. */
  async salvarPreferencias(body: PreferenciasAlerta): Promise<void> {
    const userId = await usuarioAtual();
    const { error } = await supabase
      .from("alerta_preferencias")
      .update({
        limite_saldo_alerta: body.limite_saldo_alerta,
        dias_antecedencia_vencimento: body.dias_antecedencia_vencimento,
        canal_in_app: body.canais.in_app.ativo,
        canal_push: body.canais.push.ativo,
        canal_whatsapp: body.canais.whatsapp.ativo,
        canal_email: body.canais.email.ativo,
        tipos_silenciados: body.tipos_silenciados,
      })
      .eq("user_id", userId);
    if (error) throw erroSupabase(error);
  },

  /** Idempotente por token: o mesmo aparelho reloga sem duplicar linha. */
  async registrarDispositivo(body: {
    token: string;
    plataforma: "android" | "ios" | "web";
    modelo?: string;
  }): Promise<void> {
    const userId = await usuarioAtual();
    const { error } = await supabase.from("dispositivos").upsert(
      {
        user_id: userId,
        token: body.token,
        plataforma: body.plataforma,
        modelo: body.modelo ?? "",
        ativo: true,
        usado_em: new Date().toISOString(),
      },
      { onConflict: "token" },
    );
    if (error) throw erroSupabase(error);
  },

  /** Chamado no logout — senão a próxima usuária do aparelho recebe alertas alheios. */
  async removerDispositivo(token: string): Promise<void> {
    const userId = await usuarioAtual();
    const { error } = await supabase
      .from("dispositivos")
      .delete()
      .eq("token", token)
      .eq("user_id", userId);
    if (error) throw erroSupabase(error);
  },
} as const;
