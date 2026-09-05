import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { Servico } from "../types";

/**
 * `servicos` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Espelha `api/app/services/servicos_service.py` (backend real, §8 do mapa).
 *
 * A tabela de preços, com os `produtos_padrao` de cada serviço: é o que faz o
 * "finalizar atendimento" já vir com os materiais preenchidos, em vez de ela
 * lembrar toda vez quanta cola gasta numa aplicação.
 *
 * `duracao_minutos` existe por causa do agendamento público (§10): é o que o
 * servidor soma para calcular quanto tempo um horário escolhido pelo cliente
 * bloqueia na agenda. Nulável no banco (serviço cadastrado antes do campo
 * existir), mas obrigatório e `> 0` em todo cadastro novo — sem duração esse
 * serviço não pode ser oferecido no link público.
 */

export interface ServicoBody {
  nome: string;
  preco: number;
  duracao_minutos: number;
  produtos_padrao: { item_estoque_id: string; quantidade: number }[];
}

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

function naoEncontrado(mensagem: string, detalhe?: unknown): ApiError {
  return new ApiError(404, "RECURSO_NAO_ENCONTRADO", mensagem, detalhe ?? null);
}

function validacaoInvalida(mensagem: string): ApiError {
  return new ApiError(422, "VALIDACAO_INVALIDA", mensagem);
}

async function usuarioAtual(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");
  return userId;
}

/** `item_estoque_id` repetido no mesmo corpo é 422 — duas linhas do mesmo item viram duas baixas. */
function validarSemDuplicata(produtos: ServicoBody["produtos_padrao"]): void {
  const ids = produtos.map((p) => p.item_estoque_id);
  if (new Set(ids).size !== ids.length) {
    throw validacaoInvalida("item_estoque_id repetido em produtos_padrao.");
  }
  if (produtos.some((p) => !(p.quantidade > 0))) {
    throw validacaoInvalida("quantidade deve ser maior que zero.");
  }
}

/** `item_estoque_id` inexistente ou inativo é 404, e nada é gravado. */
async function validarItensEstoque(userId: string, produtos: ServicoBody["produtos_padrao"]): Promise<void> {
  if (produtos.length === 0) return;
  const ids = produtos.map((p) => p.item_estoque_id);
  const { data, error } = await supabase
    .from("estoque_itens")
    .select("id, ativo")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw erroSupabase(error);
  const encontrados = new Map((data ?? []).map((i) => [i.id as string, Boolean(i.ativo)]));
  const invalidos = ids.filter((id) => !encontrados.get(id));
  if (invalidos.length > 0) {
    throw naoEncontrado("Item de estoque inválido ou inativo", { item_estoque_ids: invalidos });
  }
}

async function buscarServico(userId: string, id: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("servicos")
    .select("id")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw erroSupabase(error);
  if (!data) throw naoEncontrado("Serviço não encontrado");
  return data as { id: string };
}

async function montarProdutosPadrao(servicoIds: string[]): Promise<Map<string, Servico["produtos_padrao"]>> {
  const porServico = new Map<string, Servico["produtos_padrao"]>();
  if (servicoIds.length === 0) return porServico;

  const { data: linhas, error } = await supabase
    .from("servico_produtos_padrao")
    .select("servico_id, item_estoque_id, quantidade, estoque_itens(nome, unidade)")
    .in("servico_id", servicoIds);
  if (error) throw erroSupabase(error);

  for (const linha of linhas ?? []) {
    const item = linha.estoque_itens as unknown as { nome: string; unidade: Servico["produtos_padrao"][number]["unidade"] } | null;
    const lista = porServico.get(linha.servico_id as string) ?? [];
    lista.push({
      item_estoque_id: linha.item_estoque_id as string,
      nome: item?.nome ?? "",
      quantidade: Number(linha.quantidade),
      unidade: item?.unidade ?? "un",
    });
    porServico.set(linha.servico_id as string, lista);
  }
  return porServico;
}

export const ServicosApi = {
  async listar(): Promise<{ servicos: Servico[] }> {
    const userId = await usuarioAtual();
    const { data: servicos, error } = await supabase
      .from("servicos")
      .select("id, nome, preco, duracao_minutos")
      .eq("user_id", userId)
      .eq("ativo", true)
      .order("nome", { ascending: true });
    if (error) throw erroSupabase(error);

    const produtosPorServico = await montarProdutosPadrao((servicos ?? []).map((s) => s.id as string));

    return {
      servicos: (servicos ?? []).map((s) => ({
        id: s.id as string,
        nome: s.nome as string,
        preco: Number(s.preco),
        duracao_minutos: s.duracao_minutos === null ? null : Number(s.duracao_minutos),
        produtos_padrao: produtosPorServico.get(s.id as string) ?? [],
      })),
    };
  },

  async criar(body: ServicoBody): Promise<void> {
    const userId = await usuarioAtual();
    if (!(body.duracao_minutos > 0)) {
      throw validacaoInvalida("duracao_minutos deve ser maior que zero.");
    }
    validarSemDuplicata(body.produtos_padrao);
    await validarItensEstoque(userId, body.produtos_padrao);

    const { data: servico, error } = await supabase
      .from("servicos")
      .insert({
        user_id: userId,
        nome: body.nome,
        preco: body.preco,
        duracao_minutos: body.duracao_minutos,
        ativo: true,
      })
      .select("id")
      .single();
    if (error) throw erroSupabase(error);

    if (body.produtos_padrao.length > 0) {
      const linhas = body.produtos_padrao.map((p) => ({
        servico_id: servico.id,
        item_estoque_id: p.item_estoque_id,
        quantidade: p.quantidade,
      }));
      const { error: erroProdutos } = await supabase.from("servico_produtos_padrao").insert(linhas);
      if (erroProdutos) throw erroSupabase(erroProdutos);
    }
  },

  /** Mudar o preço não mexe em atendimento passado: lá o preço está congelado. `produtos_padrao` substitui a lista inteira. */
  async editar(id: string, body: Partial<ServicoBody>): Promise<void> {
    const userId = await usuarioAtual();
    await buscarServico(userId, id);

    if (body.duracao_minutos !== undefined && !(body.duracao_minutos > 0)) {
      throw validacaoInvalida("duracao_minutos deve ser maior que zero.");
    }
    if (body.produtos_padrao !== undefined) validarSemDuplicata(body.produtos_padrao);

    const patch: Record<string, unknown> = {};
    if (body.nome !== undefined) patch["nome"] = body.nome;
    if (body.preco !== undefined) patch["preco"] = body.preco;
    if (body.duracao_minutos !== undefined) patch["duracao_minutos"] = body.duracao_minutos;
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("servicos").update(patch).eq("id", id);
      if (error) throw erroSupabase(error);
    }

    if (body.produtos_padrao !== undefined) {
      await validarItensEstoque(userId, body.produtos_padrao);
      const { error: erroExcluir } = await supabase.from("servico_produtos_padrao").delete().eq("servico_id", id);
      if (erroExcluir) throw erroSupabase(erroExcluir);
      if (body.produtos_padrao.length > 0) {
        const linhas = body.produtos_padrao.map((p) => ({
          servico_id: id,
          item_estoque_id: p.item_estoque_id,
          quantidade: p.quantidade,
        }));
        const { error: erroInserir } = await supabase.from("servico_produtos_padrao").insert(linhas);
        if (erroInserir) throw erroSupabase(erroInserir);
      }
    }
  },

  /** Soft delete: o snapshot no atendimento preserva nome e preço históricos. */
  async excluir(id: string): Promise<void> {
    const userId = await usuarioAtual();
    await buscarServico(userId, id);
    const { error } = await supabase.from("servicos").update({ ativo: false }).eq("id", id);
    if (error) throw erroSupabase(error);
  },
} as const;
