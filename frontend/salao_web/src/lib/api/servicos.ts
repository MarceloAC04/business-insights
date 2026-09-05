import { AppApi } from "../http";
import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { Servico } from "../types";
import { Paths } from "./paths";

/**
 * `servicos` — leitura já em Supabase direto (branch `feat/react-supabase`);
 * as escritas (criar/editar/excluir) ainda passam pelo FastAPI antigo —
 * migram quando chegar a vez deste módulo. `GET /servicos` foi adiantado
 * porque `atendimentos` depende dele: sem a tabela de preços não dá para
 * escolher serviço nenhum, e sem `produtos_padrao` o "finalizar atendimento"
 * não pré-preenche os materiais.
 *
 * A tabela de preços, com os `produtos_padrao` de cada serviço: é o que faz o
 * "finalizar atendimento" já vir com os materiais preenchidos, em vez de ela
 * lembrar toda vez quanta cola gasta numa aplicação.
 */

export interface ServicoBody {
  nome: string;
  preco: number;
  produtos_padrao: { item_estoque_id: string; quantidade: number }[];
}

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

export const ServicosApi = {
  async listar(): Promise<{ servicos: Servico[] }> {
    const { data: servicos, error } = await supabase
      .from("servicos")
      .select("id, nome, preco")
      .eq("ativo", true)
      .order("nome", { ascending: true });
    if (error) throw erroSupabase(error);

    const ids = (servicos ?? []).map((s) => s.id as string);
    const produtosPorServico = new Map<string, Servico["produtos_padrao"]>();
    if (ids.length > 0) {
      const { data: padrao, error: erroPadrao } = await supabase
        .from("servico_produtos_padrao")
        .select("servico_id, item_estoque_id, quantidade, estoque_itens(nome, unidade)")
        .in("servico_id", ids);
      if (erroPadrao) throw erroSupabase(erroPadrao);
      for (const linha of padrao ?? []) {
        const item = linha.estoque_itens as unknown as { nome: string; unidade: Servico["produtos_padrao"][number]["unidade"] } | null;
        const lista = produtosPorServico.get(linha.servico_id as string) ?? [];
        lista.push({
          item_estoque_id: linha.item_estoque_id as string,
          nome: item?.nome ?? "",
          quantidade: Number(linha.quantidade),
          unidade: item?.unidade ?? "un",
        });
        produtosPorServico.set(linha.servico_id as string, lista);
      }
    }

    return {
      servicos: (servicos ?? []).map((s) => ({
        id: s.id,
        nome: s.nome,
        preco: Number(s.preco),
        produtos_padrao: produtosPorServico.get(s.id as string) ?? [],
      })),
    };
  },

  criar(body: ServicoBody): Promise<void> {
    return AppApi.post(Paths.servicos, body).then(() => undefined);
  },

  /** Mudar o preço não mexe em atendimento passado: lá o preço está congelado. */
  editar(id: string, body: Partial<ServicoBody>): Promise<void> {
    return AppApi.patch(Paths.servico(id), body).then(() => undefined);
  },

  excluir(id: string): Promise<void> {
    return AppApi.delete(Paths.servico(id)).then(() => undefined);
  },
} as const;
