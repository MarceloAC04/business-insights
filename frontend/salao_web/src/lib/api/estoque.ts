import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type {
  CategoriaEstoque,
  EstoquePagina,
  ItemEstoque,
  Movimentacao,
  StatusEstoque,
  TipoMovimentacao,
  UnidadeEstoque,
} from "../types";

/**
 * `estoque` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Espelho de `api/app/services/estoque_service.py` (o contrato real), mesma
 * sequência de passos. O ajuste de saldo usa o mesmo RPC atômico que
 * `atendimentos` já usa (`ajustar_estoque`) — sem ele, `entrada`/`saída` de
 * duas abas ao mesmo tempo teriam uma janela de corrida entre ler o saldo e
 * gravar o novo valor. `custo_medio`/`custo_ultima_compra` (média ponderada,
 * A6) não entram no RPC — só ele mexe em saldo — por isso são recalculados
 * aqui e gravados num `update` separado, exatamente como o backend fazia.
 *
 * `status` e `deficit` continuam colunas geradas no Postgres (§2 da migração
 * `001_v1_completo.sql`): o cliente só lê o que já vem calculado.
 */

export interface ItemBody {
  nome: string;
  unidade: UnidadeEstoque;
  categoria: CategoriaEstoque;
  quantidade_atual: number;
  quantidade_minima: number;
  /** Vira o `custo_medio` inicial — daí em diante, média ponderada (A6). */
  custo_unitario: number;
  /** Código bipado com a câmera — omitido quando o item não tem um. */
  codigo_barras?: string | null;
}

export interface MovimentacaoBody {
  tipo: TipoMovimentacao;
  quantidade: number;
  motivo: string;
  /**
   * Só na `entrada`, e é o que recalcula a média ponderada móvel (A6):
   * `(saldo × custo_medio + quantidade × custo_unitario) / (saldo + quantidade)`.
   * Uma compra cara ou promocional não reescreve o custo do saldo parado.
   * `saida` e `ajuste` nunca mexem no custo.
   */
  custo_unitario?: number;
}

interface ItemRow {
  id: string;
  nome: string;
  unidade: UnidadeEstoque;
  categoria: CategoriaEstoque;
  quantidade_atual: number;
  quantidade_minima: number;
  custo_medio: number;
  custo_ultima_compra: number;
  status: StatusEstoque;
  deficit: number;
  ativo: boolean;
  codigo_barras: string | null;
}

const CAMPOS_ITEM =
  "id, nome, unidade, categoria, quantidade_atual, quantidade_minima, custo_medio, custo_ultima_compra, status, deficit, ativo, codigo_barras";

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

function naoEncontrado(): ApiError {
  return new ApiError(404, "RECURSO_NAO_ENCONTRADO", "Item de estoque não encontrado");
}

function codigoBarrasEmUso(): ApiError {
  return new ApiError(409, "CODIGO_BARRAS_JA_CADASTRADO", "Esse código de barras já está em uso por outro item.");
}

function estoqueInsuficiente(item: {
  id: string;
  nome: string;
  unidade: string;
  quantidade_disponivel: number;
  quantidade_solicitada: number;
}): ApiError {
  return new ApiError(409, "ESTOQUE_INSUFICIENTE", "Saldo insuficiente para essa saída.", {
    faltantes: [
      {
        item_estoque_id: item.id,
        nome: item.nome,
        unidade: item.unidade,
        quantidade_solicitada: item.quantidade_solicitada,
        quantidade_disponivel: item.quantidade_disponivel,
        deficit: item.quantidade_solicitada - item.quantidade_disponivel,
      },
    ],
  });
}

function itemDaLinha(row: ItemRow): ItemEstoque {
  return {
    id: row.id,
    nome: row.nome,
    unidade: row.unidade,
    categoria: row.categoria,
    quantidade_atual: Number(row.quantidade_atual),
    quantidade_minima: Number(row.quantidade_minima),
    custo_medio: Number(row.custo_medio),
    custo_ultima_compra: Number(row.custo_ultima_compra),
    status: row.status,
    deficit: Number(row.deficit),
    ativo: row.ativo,
    codigo_barras: row.codigo_barras,
  };
}

async function usuarioAtual(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");
  return userId;
}

async function buscarItem(id: string): Promise<ItemRow> {
  const { data, error } = await supabase.from("estoque_itens").select(CAMPOS_ITEM).eq("id", id).maybeSingle();
  if (error) throw erroSupabase(error);
  if (!data) throw naoEncontrado();
  return data as unknown as ItemRow;
}

async function validarCodigoBarrasLivre(codigo: string, ignorarItemId?: string): Promise<void> {
  let query = supabase.from("estoque_itens").select("id").eq("codigo_barras", codigo);
  if (ignorarItemId) query = query.neq("id", ignorarItemId);
  const { data, error } = await query;
  if (error) throw erroSupabase(error);
  if (data && data.length > 0) throw codigoBarrasEmUso();
}

/** Ajusta o saldo de um item pelo RPC atômico — `null` quando a trava impediu. */
async function ajustarEstoque(itemId: string, delta: number, permitirNegativo: boolean): Promise<number | null> {
  const { data, error } = await supabase
    .rpc("ajustar_estoque", { p_item_id: itemId, p_delta: delta, p_permitir_negativo: permitirNegativo })
    .maybeSingle();
  if (error) throw erroSupabase(error);
  return data ? Number((data as { quantidade_atual: number }).quantidade_atual) : null;
}

export const EstoqueApi = {
  async listarItens(params?: { codigo_barras?: string }): Promise<EstoquePagina> {
    let query = supabase.from("estoque_itens").select(CAMPOS_ITEM).eq("ativo", true).order("nome", { ascending: true });
    if (params?.codigo_barras) {
      query = query.eq("codigo_barras", params.codigo_barras);
    }

    const { data, error } = await query;
    if (error) throw erroSupabase(error);

    const itens = (data ?? []).map((row) => itemDaLinha(row as unknown as ItemRow));
    return {
      total_alertas: itens.filter((i) => i.status !== "ok").length,
      valor_total: itens.reduce((soma, i) => (i.quantidade_atual > 0 ? soma + i.quantidade_atual * i.custo_medio : soma), 0),
      itens,
    };
  },

  /** Busca o item já cadastrado com esse código — null quando é a primeira bipagem. */
  async buscarPorCodigoBarras(codigo: string): Promise<EstoquePagina["itens"][number] | null> {
    const pagina = await EstoqueApi.listarItens({ codigo_barras: codigo });
    return pagina.itens[0] ?? null;
  },

  async criarItem(body: ItemBody): Promise<void> {
    const userId = await usuarioAtual();
    if (body.codigo_barras) await validarCodigoBarrasLivre(body.codigo_barras);

    const { error } = await supabase.from("estoque_itens").insert({
      user_id: userId,
      nome: body.nome,
      unidade: body.unidade,
      categoria: body.categoria,
      quantidade_atual: body.quantidade_atual,
      quantidade_minima: body.quantidade_minima,
      custo_medio: body.custo_unitario,
      custo_ultima_compra: body.custo_unitario,
      codigo_barras: body.codigo_barras ?? null,
      ativo: true,
    });
    if (error) throw erroSupabase(error);
  },

  async editarItem(id: string, body: Partial<ItemBody>): Promise<void> {
    await buscarItem(id);

    const patch: Record<string, unknown> = {};
    if (body.nome !== undefined) patch["nome"] = body.nome;
    if (body.unidade !== undefined) patch["unidade"] = body.unidade;
    if (body.categoria !== undefined) patch["categoria"] = body.categoria;
    if (body.quantidade_minima !== undefined) patch["quantidade_minima"] = body.quantidade_minima;
    if (body.codigo_barras !== undefined) {
      if (body.codigo_barras) await validarCodigoBarrasLivre(body.codigo_barras, id);
      patch["codigo_barras"] = body.codigo_barras;
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("estoque_itens").update(patch).eq("id", id);
      if (error) throw erroSupabase(error);
    }
  },

  /** Some o item de verdade só se nunca teve movimentação — senão, só inativa. */
  async excluirItem(id: string): Promise<void> {
    await buscarItem(id);

    const { data: movimentos, error: erroMov } = await supabase
      .from("estoque_movimentacoes")
      .select("id")
      .eq("item_id", id)
      .limit(1);
    if (erroMov) throw erroSupabase(erroMov);

    if (movimentos && movimentos.length > 0) {
      const { error } = await supabase.from("estoque_itens").update({ ativo: false }).eq("id", id);
      if (error) throw erroSupabase(error);
    } else {
      const { error } = await supabase.from("estoque_itens").delete().eq("id", id);
      if (error) throw erroSupabase(error);
    }
  },

  async criarMovimentacao(itemId: string, body: MovimentacaoBody): Promise<void> {
    const userId = await usuarioAtual();
    const item = await buscarItem(itemId);

    if (body.tipo === "saida" && item.quantidade_atual < body.quantidade) {
      throw estoqueInsuficiente({
        id: item.id,
        nome: item.nome,
        unidade: item.unidade,
        quantidade_disponivel: item.quantidade_atual,
        quantidade_solicitada: body.quantidade,
      });
    }

    // Média ponderada móvel (A6) calculada com o saldo de antes do ajuste —
    // igual ao backend, o RPC só mexe em `quantidade_atual`.
    let novoCustoMedio = item.custo_medio;
    let novoCustoUltimaCompra = item.custo_ultima_compra;
    if (body.tipo === "entrada" && body.custo_unitario !== undefined) {
      novoCustoMedio =
        item.quantidade_atual <= 0
          ? body.custo_unitario
          : (item.quantidade_atual * item.custo_medio + body.quantidade * body.custo_unitario) /
            (item.quantidade_atual + body.quantidade);
      novoCustoUltimaCompra = body.custo_unitario;
    }

    const delta = body.tipo === "saida" ? -body.quantidade : body.quantidade;
    const permitirNegativo = body.tipo !== "saida";
    const resultado = await ajustarEstoque(itemId, delta, permitirNegativo);
    if (resultado === null) {
      const { data: atual } = await supabase.from("estoque_itens").select("quantidade_atual").eq("id", itemId).maybeSingle();
      throw estoqueInsuficiente({
        id: item.id,
        nome: item.nome,
        unidade: item.unidade,
        quantidade_disponivel: Number(atual?.quantidade_atual ?? item.quantidade_atual),
        quantidade_solicitada: body.quantidade,
      });
    }

    const { error: erroMovimento } = await supabase.from("estoque_movimentacoes").insert({
      user_id: userId,
      item_id: itemId,
      tipo: body.tipo,
      quantidade: body.quantidade,
      motivo: body.motivo,
      custo_unitario: body.custo_unitario ?? null,
      forcada: false,
    });
    if (erroMovimento) throw erroSupabase(erroMovimento);

    if (novoCustoMedio !== item.custo_medio || novoCustoUltimaCompra !== item.custo_ultima_compra) {
      const { error: erroCusto } = await supabase
        .from("estoque_itens")
        .update({ custo_medio: novoCustoMedio, custo_ultima_compra: novoCustoUltimaCompra })
        .eq("id", itemId);
      if (erroCusto) throw erroSupabase(erroCusto);
    }
  },

  async listarMovimentacoes(params?: {
    item_id?: string;
    inicio?: string;
    fim?: string;
    tipo?: TipoMovimentacao;
  }): Promise<{ movimentacoes: Movimentacao[] }> {
    let query = supabase
      .from("estoque_movimentacoes")
      .select("id, item_id, tipo, quantidade, motivo, atendimento_id, criado_em")
      .order("criado_em", { ascending: false });
    if (params?.item_id) query = query.eq("item_id", params.item_id);
    if (params?.tipo) query = query.eq("tipo", params.tipo);
    if (params?.inicio) query = query.gte("criado_em", `${params.inicio}T00:00:00-03:00`);
    if (params?.fim) query = query.lte("criado_em", `${params.fim}T23:59:59-03:00`);

    const { data, error } = await query;
    if (error) throw erroSupabase(error);
    const linhas = data ?? [];

    const idsItem = [...new Set(linhas.map((m) => m.item_id as string))];
    const nomes = new Map<string, string>();
    if (idsItem.length > 0) {
      const { data: itens, error: erroItens } = await supabase.from("estoque_itens").select("id, nome").in("id", idsItem);
      if (erroItens) throw erroSupabase(erroItens);
      for (const i of itens ?? []) nomes.set(i.id as string, i.nome as string);
    }

    return {
      movimentacoes: linhas.map((m) => ({
        id: m.id,
        item_id: m.item_id,
        item_nome: nomes.get(m.item_id as string) ?? "",
        tipo: m.tipo,
        quantidade: Number(m.quantidade),
        motivo: m.motivo ?? "",
        atendimento_id: m.atendimento_id,
        criado_em: m.criado_em,
      })),
    };
  },
} as const;
