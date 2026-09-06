import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { Atendimento, AtendimentosPagina, StatusAtendimento } from "../types";

/**
 * `atendimentos` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Espelho de `api/app/services/atendimentos_service.py` (o contrato real, não
 * o modo demo do Flutter) — mesma sequência de passos, só que rodando no
 * navegador. A única exceção ao "cliente fala direto com o Supabase" é o
 * ajuste de saldo do estoque: `rpc('ajustar_estoque', ...)` faz, num
 * `update` só, a conta e a trava de saldo insuficiente — sem isso, duas
 * finalizações do mesmo item ao mesmo tempo teriam uma janela de corrida
 * entre ler o saldo e gravar o novo valor (PostgREST não aceita
 * `coluna = coluna + delta` no corpo do update, só literal). É o único RPC
 * do app; todo o resto — inserir, atualizar, montar o objeto de saída —
 * continua em chamadas simples, como os outros módulos já migrados.
 *
 * Um atendimento tem **N serviços**, não um só: "sobrancelha + cílios na mesma
 * cadeira" é um atendimento, e é assim que o saldo do dia fecha.
 */

/** Do catálogo (`servico_id`) ou avulso (`nome` + `preco`) — nunca os dois. */
export type ServicoEntrada = { servico_id: string } | { nome: string; preco: number };

/**
 * Do estoque (`item_estoque_id`, baixa o saldo) ou avulso (`nome` + `preco`,
 * só entra no custo).
 */
export type MaterialEntrada =
  | { item_estoque_id: string; quantidade: number }
  | { nome: string; quantidade: number; preco: number };

export interface AtendimentoBody {
  cliente_nome: string;
  cliente_telefone?: string | null;
  /** ISO-8601 com offset. Data e hora são um campo só. */
  data: string;
  servicos: ServicoEntrada[];
}

export interface FinalizarBody {
  materiais: MaterialEntrada[];
  /**
   * Segunda passada de A5. `false` na primeira tentativa: nada é gravado e
   * sai `ESTOQUE_INSUFICIENTE` com `result.faltantes`. Só depois do
   * "registrar mesmo assim" isto vai `true` — e aí o saldo fica negativo de
   * propósito, porque o produto foi usado de verdade.
   */
  confirmar_estoque_insuficiente: boolean;
}

interface FaltanteEstoque {
  item_estoque_id: string;
  nome: string;
  unidade: string;
  quantidade_solicitada: number;
  quantidade_disponivel: number;
  deficit: number;
}

interface AtendimentoRow {
  id: string;
  nome_cliente: string;
  telefone_cliente: string | null;
  data: string;
  status: StatusAtendimento;
  atendimento_servicos: { servico_id: string | null; nome_servico: string; preco_snapshot: number }[] | null;
  atendimento_insumos:
    | { item_estoque_id: string | null; nome: string; quantidade: number; preco: number }[]
    | null;
}

const SELECT_ATENDIMENTO =
  "id, nome_cliente, telefone_cliente, data, status, " +
  "atendimento_servicos(servico_id, nome_servico, preco_snapshot), " +
  "atendimento_insumos(item_estoque_id, nome, quantidade, preco)";

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

function naoEncontrado(): ApiError {
  return new ApiError(404, "RECURSO_NAO_ENCONTRADO", "Atendimento não encontrado");
}

function statusInvalido(mensagem: string): ApiError {
  return new ApiError(409, "ATENDIMENTO_STATUS_INVALIDO", mensagem);
}

function estoqueInsuficiente(faltantes: FaltanteEstoque[]): ApiError {
  return new ApiError(409, "ESTOQUE_INSUFICIENTE", "Alguns materiais estão sem saldo em estoque.", {
    faltantes,
  });
}

function atendimentoDaLinha(row: AtendimentoRow): Atendimento {
  const servicos = (row.atendimento_servicos ?? []).map((s) => ({
    servico_id: s.servico_id,
    nome: s.nome_servico,
    preco: Number(s.preco_snapshot),
  }));
  const materiais = (row.atendimento_insumos ?? []).map((m) => ({
    item_estoque_id: m.item_estoque_id,
    nome: m.nome,
    quantidade: Number(m.quantidade),
    preco: Number(m.preco),
  }));
  const totalServicos = servicos.reduce((s, x) => s + x.preco, 0);
  const totalMateriais = materiais.reduce((s, x) => s + x.preco * x.quantidade, 0);
  return {
    id: row.id,
    cliente_nome: row.nome_cliente,
    cliente_telefone: row.telefone_cliente || null,
    data: row.data,
    status: row.status,
    servicos,
    materiais,
    total_servicos: totalServicos,
    total_materiais: totalMateriais,
    saldo: totalServicos - totalMateriais,
  };
}

/** Congela `{servico_id, nome, preco}` do catálogo — avulso passa direto. */
async function resolverServicos(
  entradas: ServicoEntrada[],
): Promise<{ servico_id: string | null; nome: string; preco: number }[]> {
  const ids = entradas
    .map((e) => ("servico_id" in e ? e.servico_id : null))
    .filter((id): id is string => id !== null);

  const catalogo = new Map<string, { nome: string; preco: number }>();
  if (ids.length > 0) {
    const { data, error } = await supabase.from("servicos").select("id, nome, preco").in("id", ids);
    if (error) throw erroSupabase(error);
    for (const s of data ?? []) catalogo.set(s.id as string, { nome: s.nome, preco: Number(s.preco) });
    const faltantes = ids.filter((id) => !catalogo.has(id));
    if (faltantes.length > 0) {
      throw new ApiError(422, "VALIDACAO_INVALIDA", "Serviço inválido para este salão", {
        servico_ids: faltantes,
      });
    }
  }

  return entradas.map((e) => {
    if ("servico_id" in e) {
      const s = catalogo.get(e.servico_id)!;
      return { servico_id: e.servico_id, nome: s.nome, preco: s.preco };
    }
    return { servico_id: null, nome: e.nome, preco: e.preco };
  });
}

async function buscarAtendimento(id: string): Promise<{ id: string; status: StatusAtendimento }> {
  const { data, error } = await supabase.from("atendimentos").select("id, status").eq("id", id).maybeSingle();
  if (error) throw erroSupabase(error);
  if (!data) throw naoEncontrado();
  return data;
}

async function obterMontado(id: string): Promise<Atendimento> {
  const { data, error } = await supabase.from("atendimentos").select(SELECT_ATENDIMENTO).eq("id", id).maybeSingle();
  if (error) throw erroSupabase(error);
  if (!data) throw naoEncontrado();
  return atendimentoDaLinha(data as unknown as AtendimentoRow);
}

/** Ajusta o saldo de um item pelo RPC atômico — `null` quando a trava impediu. */
async function ajustarEstoque(
  itemId: string,
  delta: number,
  permitirNegativo: boolean,
): Promise<number | null> {
  const { data, error } = await supabase
    .rpc("ajustar_estoque", { p_item_id: itemId, p_delta: delta, p_permitir_negativo: permitirNegativo })
    .maybeSingle();
  if (error) throw erroSupabase(error);
  return data ? Number((data as { quantidade_atual: number }).quantidade_atual) : null;
}

export const AtendimentosApi = {
  async listar(params: {
    inicio: string;
    fim: string;
    status?: StatusAtendimento[];
  }): Promise<AtendimentosPagina> {
    let query = supabase
      .from("atendimentos")
      .select(SELECT_ATENDIMENTO)
      .gte("data", `${params.inicio}T00:00:00-03:00`)
      .lte("data", `${params.fim}T23:59:59-03:00`)
      .order("data", { ascending: false });
    if (params.status?.length) query = query.in("status", params.status);

    const { data, error } = await query;
    if (error) throw erroSupabase(error);

    const atendimentos = (data ?? []).map((row) => atendimentoDaLinha(row as unknown as AtendimentoRow));
    const saldoLiquido = atendimentos
      .filter((a) => a.status !== "cancelado")
      .reduce((s, a) => s + a.saldo, 0);
    return { saldo_liquido: saldoLiquido, quantidade: atendimentos.length, atendimentos };
  },

  obter(id: string): Promise<Atendimento> {
    return obterMontado(id);
  },

  async criar(body: AtendimentoBody): Promise<void> {
    const servicos = await resolverServicos(body.servicos);

    const usuario = (await supabase.auth.getUser()).data.user;
    if (!usuario) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");

    const { data: atendimento, error } = await supabase
      .from("atendimentos")
      .insert({
        user_id: usuario.id,
        nome_cliente: body.cliente_nome,
        telefone_cliente: body.cliente_telefone ?? "",
        data: body.data,
        status: "agendado",
        origem: "interno",
      })
      .select("id")
      .single();
    if (error) throw erroSupabase(error);

    const linhasServico = servicos.map((s) => ({
      atendimento_id: atendimento.id,
      servico_id: s.servico_id,
      nome_servico: s.nome,
      preco_snapshot: s.preco,
    }));
    const { error: erroServicos } = await supabase.from("atendimento_servicos").insert(linhasServico);
    if (erroServicos) throw erroSupabase(erroServicos);
  },

  async editar(id: string, body: AtendimentoBody): Promise<void> {
    const atendimento = await buscarAtendimento(id);
    if (atendimento.status === "cancelado") {
      throw statusInvalido("Atendimento cancelado não pode ser editado");
    }

    const servicos = await resolverServicos(body.servicos);

    const { error } = await supabase
      .from("atendimentos")
      .update({
        nome_cliente: body.cliente_nome,
        telefone_cliente: body.cliente_telefone ?? "",
        data: body.data,
      })
      .eq("id", id);
    if (error) throw erroSupabase(error);

    const { error: erroExcluir } = await supabase.from("atendimento_servicos").delete().eq("atendimento_id", id);
    if (erroExcluir) throw erroSupabase(erroExcluir);

    const linhasServico = servicos.map((s) => ({
      atendimento_id: id,
      servico_id: s.servico_id,
      nome_servico: s.nome,
      preco_snapshot: s.preco,
    }));
    const { error: erroInserir } = await supabase.from("atendimento_servicos").insert(linhasServico);
    if (erroInserir) throw erroSupabase(erroInserir);
  },

  /** Lança `ApiError` com `ESTOQUE_INSUFICIENTE` na primeira passada (A5). */
  async finalizar(id: string, body: FinalizarBody): Promise<void> {
    const atendimento = await buscarAtendimento(id);
    if (atendimento.status !== "agendado") {
      throw statusInvalido("Só é possível finalizar um atendimento agendado");
    }

    const usuario = (await supabase.auth.getUser()).data.user;
    if (!usuario) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");

    const idsEstoque = [
      ...new Set(
        body.materiais
          .map((m) => ("item_estoque_id" in m ? m.item_estoque_id : null))
          .filter((v): v is string => v !== null),
      ),
    ];

    const itensEstoque = new Map<
      string,
      { id: string; nome: string; unidade: string; quantidade_atual: number; custo_medio: number }
    >();
    if (idsEstoque.length > 0) {
      const { data, error } = await supabase
        .from("estoque_itens")
        .select("id, nome, unidade, quantidade_atual, custo_medio")
        .in("id", idsEstoque);
      if (error) throw erroSupabase(error);
      for (const item of data ?? []) {
        itensEstoque.set(item.id as string, {
          id: item.id,
          nome: item.nome,
          unidade: item.unidade,
          quantidade_atual: Number(item.quantidade_atual),
          custo_medio: Number(item.custo_medio),
        });
      }
      const faltantesCadastro = idsEstoque.filter((id2) => !itensEstoque.has(id2));
      if (faltantesCadastro.length > 0) {
        throw new ApiError(422, "VALIDACAO_INVALIDA", "Item de estoque inválido para este salão", {
          item_estoque_ids: faltantesCadastro,
        });
      }
    }

    // Soma por item — a mesma composição pode aparecer em mais de uma linha.
    const pedidos = new Map<string, number>();
    for (const m of body.materiais) {
      if ("item_estoque_id" in m) pedidos.set(m.item_estoque_id, (pedidos.get(m.item_estoque_id) ?? 0) + m.quantidade);
    }

    const faltantes: FaltanteEstoque[] = [];
    for (const [itemId, quantidade] of pedidos) {
      const item = itensEstoque.get(itemId)!;
      if (item.quantidade_atual < quantidade) {
        faltantes.push({
          item_estoque_id: item.id,
          nome: item.nome,
          unidade: item.unidade,
          quantidade_solicitada: quantidade,
          quantidade_disponivel: item.quantidade_atual,
          deficit: quantidade - item.quantidade_atual,
        });
      }
    }

    if (faltantes.length > 0 && !body.confirmar_estoque_insuficiente) {
      throw estoqueInsuficiente(faltantes);
    }
    const itensComDeficit = new Set(faltantes.map((f) => f.item_estoque_id));

    // Decremento atômico primeiro — se a corrida com outra finalização
    // simultânea fizer a trava disparar (saldo mudou entre a leitura acima e
    // agora), desfaz os que já tinham sido decrementados nesta chamada e
    // devolve estoque insuficiente com números atualizados, em vez de deixar
    // o atendimento gravado com baixa parcial.
    const decrementados: { itemId: string; quantidade: number }[] = [];
    for (const [itemId, quantidade] of pedidos) {
      const resultado = await ajustarEstoque(itemId, -quantidade, body.confirmar_estoque_insuficiente);
      if (resultado === null) {
        for (const d of decrementados) await ajustarEstoque(d.itemId, d.quantidade, true);
        const item = itensEstoque.get(itemId)!;
        const { data: atual } = await supabase
          .from("estoque_itens")
          .select("quantidade_atual")
          .eq("id", itemId)
          .maybeSingle();
        const disponivel = Number(atual?.quantidade_atual ?? item.quantidade_atual);
        throw estoqueInsuficiente([
          {
            item_estoque_id: item.id,
            nome: item.nome,
            unidade: item.unidade,
            quantidade_solicitada: quantidade,
            quantidade_disponivel: disponivel,
            deficit: quantidade - disponivel,
          },
        ]);
      }
      decrementados.push({ itemId, quantidade });
    }

    const linhasInsumo = body.materiais.map((m) =>
      "item_estoque_id" in m
        ? {
            atendimento_id: id,
            item_estoque_id: m.item_estoque_id,
            nome: itensEstoque.get(m.item_estoque_id)!.nome,
            quantidade: m.quantidade,
            // Custo do material é o custo médio de hoje (A6), congelado na linha.
            preco: itensEstoque.get(m.item_estoque_id)!.custo_medio,
          }
        : { atendimento_id: id, item_estoque_id: null, nome: m.nome, quantidade: m.quantidade, preco: m.preco },
    );
    if (linhasInsumo.length > 0) {
      const { error } = await supabase.from("atendimento_insumos").insert(linhasInsumo);
      if (error) throw erroSupabase(error);
    }

    for (const [itemId, quantidade] of pedidos) {
      const item = itensEstoque.get(itemId)!;
      const { error } = await supabase.from("estoque_movimentacoes").insert({
        user_id: usuario.id,
        item_id: itemId,
        tipo: "saida",
        quantidade,
        motivo: "Consumo em atendimento",
        custo_unitario: item.custo_medio,
        atendimento_id: id,
        forcada: itensComDeficit.has(itemId),
      });
      if (error) throw erroSupabase(error);
    }

    // custo_insumos_snapshot: composição padrão × custo médio no fechamento —
    // congela o custo do serviço para o resumo, independente do que foi de
    // fato consumido acima (§4/§8 do contrato).
    const { data: servicosDoAtendimento, error: erroServicos } = await supabase
      .from("atendimento_servicos")
      .select("id, servico_id")
      .eq("atendimento_id", id);
    if (erroServicos) throw erroSupabase(erroServicos);
    for (const s of servicosDoAtendimento ?? []) {
      if (!s.servico_id) continue;
      const { data: padrao, error: erroPadrao } = await supabase
        .from("servico_produtos_padrao")
        .select("item_estoque_id, quantidade")
        .eq("servico_id", s.servico_id);
      if (erroPadrao) throw erroSupabase(erroPadrao);
      if (!padrao || padrao.length === 0) continue;
      const idsPadrao = padrao.map((p) => p.item_estoque_id);
      const { data: custos, error: erroCustos } = await supabase
        .from("estoque_itens")
        .select("id, custo_medio")
        .in("id", idsPadrao);
      if (erroCustos) throw erroSupabase(erroCustos);
      const custoPorId = new Map((custos ?? []).map((c) => [c.id as string, Number(c.custo_medio)]));
      const custoTotal = padrao.reduce(
        (soma, p) => soma + Number(p.quantidade) * (custoPorId.get(p.item_estoque_id) ?? 0),
        0,
      );
      const { error: erroSnapshot } = await supabase
        .from("atendimento_servicos")
        .update({ custo_insumos_snapshot: custoTotal })
        .eq("id", s.id);
      if (erroSnapshot) throw erroSupabase(erroSnapshot);
    }

    if (faltantes.length > 0) {
      const chaves = faltantes.map((f) => `estoque_negativo:${f.item_estoque_id}:${id}`);
      // O índice de dedupe é único parcial (`where resolvido_em is null`) — o
      // `on_conflict` do PostgREST não expressa esse predicado, então a
      // checagem é manual: busca o que já está vivo e insere só o resto, em
      // vez de depender de `upsert` contra um índice parcial.
      const { data: existentes, error: erroExistentes } = await supabase
        .from("alertas")
        .select("chave_dedupe")
        .is("resolvido_em", null)
        .in("chave_dedupe", chaves);
      if (erroExistentes) throw erroSupabase(erroExistentes);
      const jaExiste = new Set((existentes ?? []).map((a) => a.chave_dedupe as string));

      const linhasAlerta = faltantes
        .filter((f) => !jaExiste.has(`estoque_negativo:${f.item_estoque_id}:${id}`))
        .map((f) => ({
          user_id: usuario.id,
          tipo: "estoque_negativo",
          severidade: "alerta",
          titulo: `Estoque negativo: ${f.nome}`,
          mensagem: `${f.nome} ficou com saldo negativo após o atendimento`,
          referencia_tipo: "estoque_item",
          referencia_id: f.item_estoque_id,
          chave_dedupe: `estoque_negativo:${f.item_estoque_id}:${id}`,
        }));
      if (linhasAlerta.length > 0) {
        const { error: erroAlerta } = await supabase.from("alertas").insert(linhasAlerta);
        if (erroAlerta) throw erroSupabase(erroAlerta);
      }
    }

    const { error: erroStatus } = await supabase
      .from("atendimentos")
      .update({ status: "finalizado", finalizado_em: new Date().toISOString() })
      .eq("id", id);
    if (erroStatus) throw erroSupabase(erroStatus);
  },

  /** Devolve ao estoque o que um atendimento já finalizado tinha consumido. */
  async cancelar(id: string): Promise<void> {
    const atendimento = await buscarAtendimento(id);
    if (atendimento.status === "cancelado") {
      throw statusInvalido("Atendimento já está cancelado");
    }

    if (atendimento.status === "finalizado") {
      const usuario = (await supabase.auth.getUser()).data.user;
      if (!usuario) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");

      const { data: movimentos, error } = await supabase
        .from("estoque_movimentacoes")
        .select("item_id, quantidade")
        .eq("atendimento_id", id)
        .eq("tipo", "saida");
      if (error) throw erroSupabase(error);

      for (const mov of movimentos ?? []) {
        // Estorno sempre cabe (devolve saldo) — não precisa da trava de A5.
        await ajustarEstoque(mov.item_id, Number(mov.quantidade), true);
        const { error: erroMov } = await supabase.from("estoque_movimentacoes").insert({
          user_id: usuario.id,
          item_id: mov.item_id,
          tipo: "ajuste",
          quantidade: mov.quantidade,
          motivo: "Estorno — atendimento cancelado",
          atendimento_id: id,
          forcada: false,
        });
        if (erroMov) throw erroSupabase(erroMov);
      }
    }

    const { error } = await supabase
      .from("atendimentos")
      .update({ status: "cancelado", cancelado_em: new Date().toISOString() })
      .eq("id", id);
    if (error) throw erroSupabase(error);
  },

  async excluir(id: string): Promise<void> {
    const atendimento = await buscarAtendimento(id);
    if (atendimento.status !== "agendado") {
      throw statusInvalido("Só é possível excluir um atendimento agendado");
    }
    const { error } = await supabase.from("atendimentos").delete().eq("id", id);
    if (error) throw erroSupabase(error);
  },
} as const;
