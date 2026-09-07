import { AppApi } from "../http";
import type {
  CategoriaEstoque,
  EstoquePagina,
  ModoControleEstoque,
  Movimentacao,
  TipoMovimentacao,
  UnidadeEstoque,
} from "../types";
import { Paths } from "./paths";

/**
 * `estoque` — 6 operações (§5 do contrato).
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
  /** Padrão "quantidade" quando omitido — controle por saldo, como sempre foi. */
  modo_controle?: ModoControleEstoque;
  /** Obrigatório quando `modo_controle` é "validade_dias". */
  duracao_dias?: number | null;
  /** Obrigatório quando `modo_controle` é "validade_atendimentos". */
  duracao_atendimentos?: number | null;
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

export const EstoqueApi = {
  listarItens(params?: { codigo_barras?: string }): Promise<EstoquePagina> {
    return AppApi.get<EstoquePagina>(Paths.estoqueItens, params).then((r) => r.result);
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

  /** "Abri agora" — reinicia dias/atendimentos sem lançar entrada (item já era dela, não foi compra nova). */
  abrirUnidade(itemId: string): Promise<void> {
    return AppApi.post(Paths.abrirUnidadeEstoque(itemId), {}).then(() => undefined);
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
