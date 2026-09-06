import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { CategoriaGasto, FormaPagamento, Gasto, GastosPagina } from "../types";

/**
 * `gastos` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Não existe (nem nunca existiu) `api/app/services/gastos_service.py` — este
 * módulo não tinha backend real, só o contrato planejado em
 * `.specs/endpoints-backend.md` (§3) e a regra de negócio do
 * `demo_database.dart`. A fonte de verdade aqui é o spec (ele é quem venceu a
 * divergência de `forma_pagamento`/`categoria` do `schema.sql` antigo — já
 * resolvida pela migration `001`), com uma exceção: o spec pede `pagar`
 * idempotente (gasto já pago devolve 200 com o estado atual); o demo lançava
 * `GASTO_JA_PAGO`. Segue o spec — é o documento marcado como contrato
 * vencedor.
 *
 * Gasto é compromisso com prazo, não lançamento no caixa: nasce pendente e a
 * baixa é um ato separado (`pagar`). `vence_em_dias` é calculado aqui, na
 * borda — mesma regra que gera o alerta de vencimento (negativo = vencido).
 *
 * `itens` (compras detalhadas por gasto) não tem tabela própria no banco
 * ainda — sempre vazio até esse contrato ser implementado.
 */
export interface GastoBody {
  nome: string;
  valor: number;
  /** `date` puro, `AAAA-MM-DD`. */
  prazo_pagamento: string;
  forma_pagamento: FormaPagamento;
  categoria: CategoriaGasto;
  itens?: { nome: string; preco: number }[];
}

interface GastoRow {
  id: string;
  nome: string;
  valor: number;
  prazo: string;
  forma_pagamento: FormaPagamento;
  categoria: CategoriaGasto;
  pago: boolean;
  pago_em: string | null;
}

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

function naoEncontrado(): ApiError {
  return new ApiError(404, "RECURSO_NAO_ENCONTRADO", "Gasto não encontrado.");
}

/** Meia-noite local de hoje, para comparar com `prazo` (`date` puro). */
function hojeLocal(): Date {
  const agora = new Date();
  return new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
}

function parseDataLocal(valor: string): Date {
  const [ano, mes, dia] = valor.split("-").map(Number);
  return new Date(ano ?? 1970, (mes ?? 1) - 1, dia ?? 1);
}

function diferencaEmDias(alvo: Date, referencia: Date): number {
  return Math.round((alvo.getTime() - referencia.getTime()) / 86_400_000);
}

function gastoDaLinha(row: GastoRow): Gasto {
  return {
    id: row.id,
    nome: row.nome,
    valor: Number(row.valor),
    prazo_pagamento: row.prazo,
    forma_pagamento: row.forma_pagamento,
    categoria: row.categoria,
    pago: row.pago,
    pago_em: row.pago_em,
    vence_em_dias: diferencaEmDias(parseDataLocal(row.prazo), hojeLocal()),
    itens: [],
  };
}

async function usuarioAtual(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");
  return userId;
}

export const GastosApi = {
  async listar(params: { ano: number; mes: number }): Promise<GastosPagina> {
    const inicio = `${params.ano}-${String(params.mes).padStart(2, "0")}-01`;
    const proximoMes = params.mes === 12 ? 1 : params.mes + 1;
    const proximoAno = params.mes === 12 ? params.ano + 1 : params.ano;
    const fim = `${proximoAno}-${String(proximoMes).padStart(2, "0")}-01`;

    const { data, error } = await supabase
      .from("gastos")
      .select("id, nome, valor, prazo, forma_pagamento, categoria, pago, pago_em")
      .gte("prazo", inicio)
      .lt("prazo", fim)
      .order("prazo", { ascending: true });
    if (error) throw erroSupabase(error);

    const gastos = (data ?? []).map(gastoDaLinha);
    return {
      total_pendente: gastos.filter((g) => !g.pago).reduce((soma, g) => soma + g.valor, 0),
      total_pago_mes: gastos.filter((g) => g.pago).reduce((soma, g) => soma + g.valor, 0),
      gastos,
    };
  },

  async criar(body: GastoBody): Promise<void> {
    const userId = await usuarioAtual();
    const { error } = await supabase.from("gastos").insert({
      user_id: userId,
      nome: body.nome,
      valor: body.valor,
      prazo: body.prazo_pagamento,
      forma_pagamento: body.forma_pagamento,
      categoria: body.categoria,
      pago: false,
      pago_em: null,
    });
    if (error) throw erroSupabase(error);
  },

  async editar(id: string, body: Partial<GastoBody>): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (body.nome !== undefined) patch["nome"] = body.nome;
    if (body.valor !== undefined) patch["valor"] = body.valor;
    if (body.prazo_pagamento !== undefined) patch["prazo"] = body.prazo_pagamento;
    if (body.forma_pagamento !== undefined) patch["forma_pagamento"] = body.forma_pagamento;
    if (body.categoria !== undefined) patch["categoria"] = body.categoria;

    const { data, error } = await supabase.from("gastos").update(patch).eq("id", id).select("id");
    if (error) throw erroSupabase(error);
    if (!data || data.length === 0) throw naoEncontrado();
  },

  /** Idempotente (§3 do spec): gasto já pago não é erro, só devolve como está. */
  async pagar(id: string, pagoEm?: string): Promise<void> {
    const { data: atual, error: erroAtual } = await supabase
      .from("gastos")
      .select("id, pago")
      .eq("id", id)
      .maybeSingle();
    if (erroAtual) throw erroSupabase(erroAtual);
    if (!atual) throw naoEncontrado();
    if (atual.pago) return;

    const { error } = await supabase
      .from("gastos")
      .update({ pago: true, pago_em: pagoEm ?? new Date().toISOString() })
      .eq("id", id);
    if (error) throw erroSupabase(error);
  },

  async excluir(id: string): Promise<void> {
    const { data, error } = await supabase.from("gastos").delete().eq("id", id).select("id");
    if (error) throw erroSupabase(error);
    if (!data || data.length === 0) throw naoEncontrado();
  },
} as const;
