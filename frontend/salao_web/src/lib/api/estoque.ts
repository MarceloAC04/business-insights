import { AppApi } from "../http";
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
import { Paths } from "./paths";

/**
 * `estoque` — leitura de itens já em Supabase direto (branch
 * `feat/react-supabase`); movimentações e escritas ainda passam pelo FastAPI
 * antigo — migram quando chegar a vez deste módulo. `GET /estoque/itens` foi
 * adiantado porque a tela de Resumo depende dele para "estoque para repor".
 *
 * `status` e `deficit` são colunas geradas no Postgres (§2 da migração
 * `001_v1_completo.sql`): a mesma regra alimenta app, push e n8n sem poder
 * divergir entre eles — o cliente só lê o que já vem calculado.
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

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
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

export const EstoqueApi = {
  async listarItens(params?: { codigo_barras?: string }): Promise<EstoquePagina> {
    let query = supabase
      .from("estoque_itens")
      .select(
        "id, nome, unidade, categoria, quantidade_atual, quantidade_minima, custo_medio, custo_ultima_compra, status, deficit, ativo, codigo_barras",
      )
      .eq("ativo", true)
      .order("nome", { ascending: true });
    if (params?.codigo_barras) {
      query = query.eq("codigo_barras", params.codigo_barras);
    }

    const { data, error } = await query;
    if (error) throw erroSupabase(error);

    const itens = (data ?? []).map(itemDaLinha);
    return {
      total_alertas: itens.filter((i) => i.status !== "ok").length,
      valor_total: itens.reduce((soma, i) => soma + i.quantidade_atual * i.custo_medio, 0),
      itens,
    };
  },

  /** Busca o item já cadastrado com esse código — null quando é a primeira bipagem. */
  async buscarPorCodigoBarras(codigo: string): Promise<EstoquePagina["itens"][number] | null> {
    const pagina = await EstoqueApi.listarItens({ codigo_barras: codigo });
    return pagina.itens[0] ?? null;
  },

  criarItem(body: ItemBody): Promise<void> {
    return AppApi.post(Paths.estoqueItens, body).then(() => undefined);
  },

  editarItem(id: string, body: Partial<ItemBody>): Promise<void> {
    return AppApi.patch(Paths.estoqueItem(id), body).then(() => undefined);
  },

  /** `409 ITEM_EM_USO` quando o item compõe kit ou serviço — some o item, some a conta. */
  excluirItem(id: string): Promise<void> {
    return AppApi.delete(Paths.estoqueItem(id)).then(() => undefined);
  },

  criarMovimentacao(itemId: string, body: MovimentacaoBody): Promise<void> {
    return AppApi.post(Paths.movimentacoesDoItem(itemId), body).then(() => undefined);
  },

  listarMovimentacoes(params?: {
    item_id?: string;
    inicio?: string;
    fim?: string;
    tipo?: TipoMovimentacao;
  }): Promise<{ movimentacoes: Movimentacao[] }> {
    return AppApi.get<{ movimentacoes: Movimentacao[] }>(Paths.movimentacoes, params).then(
      (r) => r.result,
    );
  },
} as const;
