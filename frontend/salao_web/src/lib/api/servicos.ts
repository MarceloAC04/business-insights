import { AppApi } from "../http";
import type { CategoriaServico, Servico } from "../types";
import { Paths } from "./paths";

/**
 * `servicos` — 4 operações (§7 do contrato).
 *
 * A tabela de preços, com os `produtos_padrao` de cada serviço: é o que faz o
 * "finalizar atendimento" já vir com os materiais preenchidos, em vez de ela
 * lembrar toda vez quanta cola gasta numa aplicação.
 */

export interface ServicoBody {
  nome: string;
  categoria: string;
  preco: number;
  /** Necessária para calcular os horários disponíveis do agendamento público. */
  duracao_minutos: number;
  produtos_padrao: { item_estoque_id: string; quantidade: number }[];
}

export interface CategoriaServicoBody {
  nome: string;
}

export const ServicosApi = {
  listar(): Promise<{ servicos: Servico[] }> {
    return AppApi.get<{ servicos: Servico[] }>(Paths.servicos).then((r) => r.result);
  },

  criar(body: ServicoBody): Promise<Servico> {
    return AppApi.post<Servico>(Paths.servicos, body).then((r) => r.result);
  },

  /** Mudar o preço não mexe em atendimento passado: lá o preço está congelado. */
  editar(id: string, body: Partial<ServicoBody>): Promise<Servico> {
    return AppApi.patch<Servico>(Paths.servico(id), body).then((r) => r.result);
  },

  excluir(id: string): Promise<void> {
    return AppApi.delete(Paths.servico(id)).then(() => undefined);
  },

  listarCategorias(): Promise<{ categorias: CategoriaServico[] }> {
    return AppApi.get<{ categorias: CategoriaServico[] }>(Paths.categoriasServico).then(
      (r) => r.result,
    );
  },

  criarCategoria(body: CategoriaServicoBody): Promise<CategoriaServico> {
    return AppApi.post<CategoriaServico>(Paths.categoriasServico, body).then((r) => r.result);
  },
} as const;
