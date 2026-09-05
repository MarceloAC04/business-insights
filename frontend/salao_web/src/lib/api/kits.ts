import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { FormaPagamento, Kit } from "../types";

/**
 * `kits` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Não existe `api/app/services/kits_service.py` — este módulo não tinha
 * backend real, só o contrato planejado em `.specs/endpoints-backend.md`
 * (§6). A fonte de verdade aqui é o spec, com o mesmo ajuste atômico de
 * saldo (`rpc('ajustar_estoque', ...)`) que `atendimentos` e `estoque` já
 * usam para consumir insumo — montar um kit também é uma baixa de estoque.
 *
 * Montar e vender são **fatos separados** (A7): ela monta cinco kits numa
 * tarde e vende ao longo das semanas. Por isso o kit tem saldo próprio
 * (`quantidade_montada`).
 *
 * ```
 * estoque de insumos ──montar──▶ kits montados ──vender──▶ receita
 * ```
 *
 * `montar` segue a mesma mecânica de duas passadas do A5 (finalizar
 * atendimento): sem saldo, `409 ESTOQUE_INSUFICIENTE` sem gravar nada; com
 * `confirmar_estoque_insuficiente`, monta e deixa o saldo negativo.
 *
 * `vender` **não** tem segunda passada (A7): vender mais do que está
 * montado é `409 KIT_NAO_MONTADO`, definitivo — não existe "vender um kit
 * que não existe", diferente do estoque de insumo onde o negativo representa
 * um consumo real que já aconteceu.
 */

export interface KitBody {
  nome: string;
  preco_venda: number;
  itens: { item_estoque_id: string; quantidade: number }[];
}

interface FaltanteEstoque {
  item_estoque_id: string;
  nome: string;
  unidade: string;
  quantidade_solicitada: number;
  quantidade_disponivel: number;
  deficit: number;
}

interface KitRow {
  id: string;
  nome: string;
  preco_venda: number;
  quantidade_montada: number;
  ativo: boolean;
}

interface ItemEstoqueSaldo {
  id: string;
  nome: string;
  unidade: string;
  quantidade_atual: number;
  custo_medio: number;
}

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

function naoEncontrado(): ApiError {
  return new ApiError(404, "RECURSO_NAO_ENCONTRADO", "Kit não encontrado");
}

function estoqueInsuficiente(faltantes: FaltanteEstoque[]): ApiError {
  return new ApiError(409, "ESTOQUE_INSUFICIENTE", "Alguns insumos estão sem saldo em estoque.", {
    faltantes,
  });
}

function kitNaoMontado(quantidadeMontada: number, quantidadeSolicitada: number): ApiError {
  return new ApiError(409, "KIT_NAO_MONTADO", "Não há kits montados suficientes para essa venda.", {
    quantidade_montada: quantidadeMontada,
    quantidade_solicitada: quantidadeSolicitada,
  });
}

async function usuarioAtual(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");
  return userId;
}

async function buscarKit(id: string): Promise<KitRow> {
  const { data, error } = await supabase
    .from("kits")
    .select("id, nome, preco_venda, quantidade_montada, ativo")
    .eq("id", id)
    .maybeSingle();
  if (error) throw erroSupabase(error);
  if (!data) throw naoEncontrado();
  return data as unknown as KitRow;
}

/** Ajusta o saldo de um item pelo RPC atômico — `null` quando a trava impediu. */
async function ajustarEstoque(itemId: string, delta: number, permitirNegativo: boolean): Promise<number | null> {
  const { data, error } = await supabase
    .rpc("ajustar_estoque", { p_item_id: itemId, p_delta: delta, p_permitir_negativo: permitirNegativo })
    .maybeSingle();
  if (error) throw erroSupabase(error);
  return data ? Number((data as { quantidade_atual: number }).quantidade_atual) : null;
}

export const KitsApi = {
  async listar(): Promise<{ kits: Kit[] }> {
    const { data: kitsRows, error } = await supabase
      .from("kits")
      .select("id, nome, preco_venda, quantidade_montada")
      .eq("ativo", true)
      .order("nome", { ascending: true });
    if (error) throw erroSupabase(error);

    const kitIds = (kitsRows ?? []).map((k) => k.id as string);
    const composicoes = new Map<string, { item_estoque_id: string; nome: string; quantidade: number; unidade: string }[]>();
    if (kitIds.length > 0) {
      const { data: itensRows, error: erroItens } = await supabase
        .from("kit_itens")
        .select("kit_id, item_estoque_id, quantidade, estoque_itens(nome, unidade, quantidade_atual, custo_medio)")
        .in("kit_id", kitIds);
      if (erroItens) throw erroSupabase(erroItens);
      for (const linha of itensRows ?? []) {
        const item = linha.estoque_itens as unknown as ItemEstoqueSaldo | null;
        const lista = composicoes.get(linha.kit_id as string) ?? [];
        lista.push({
          item_estoque_id: linha.item_estoque_id as string,
          nome: item?.nome ?? "",
          quantidade: Number(linha.quantidade),
          unidade: (item?.unidade as string) ?? "un",
        });
        composicoes.set(linha.kit_id as string, lista);
      }
    }

    // Saldo de cada item usado em algum kit, para `custo_total`/`quantidade_montavel`.
    const idsItem = [...new Set([...composicoes.values()].flatMap((l) => l.map((i) => i.item_estoque_id)))];
    const saldos = new Map<string, ItemEstoqueSaldo>();
    if (idsItem.length > 0) {
      const { data: itens, error: erroSaldo } = await supabase
        .from("estoque_itens")
        .select("id, nome, unidade, quantidade_atual, custo_medio")
        .in("id", idsItem);
      if (erroSaldo) throw erroSupabase(erroSaldo);
      for (const i of itens ?? []) {
        saldos.set(i.id as string, {
          id: i.id as string,
          nome: i.nome as string,
          unidade: i.unidade as string,
          quantidade_atual: Number(i.quantidade_atual),
          custo_medio: Number(i.custo_medio),
        });
      }
    }

    const kits: Kit[] = (kitsRows ?? []).map((k) => {
      const itens = composicoes.get(k.id as string) ?? [];
      const custoTotal = itens.reduce((soma, i) => soma + i.quantidade * (saldos.get(i.item_estoque_id)?.custo_medio ?? 0), 0);
      const quantidadeMontavel =
        itens.length === 0
          ? 0
          : Math.min(
              ...itens.map((i) => Math.floor((saldos.get(i.item_estoque_id)?.quantidade_atual ?? 0) / i.quantidade)),
            );
      const quantidadeMontada = Number(k.quantidade_montada);
      return {
        id: k.id as string,
        nome: k.nome as string,
        preco_venda: Number(k.preco_venda),
        custo_total: custoTotal,
        margem: Number(k.preco_venda) - custoTotal,
        quantidade_montada: quantidadeMontada,
        quantidade_montavel: Math.max(0, quantidadeMontavel),
        disponivel: quantidadeMontada > 0 || quantidadeMontavel > 0,
        itens: itens.map((i) => ({
          item_estoque_id: i.item_estoque_id,
          nome: i.nome,
          quantidade: i.quantidade,
          unidade: i.unidade as Kit["itens"][number]["unidade"],
        })),
      };
    });

    return { kits };
  },

  async criar(body: KitBody): Promise<void> {
    const userId = await usuarioAtual();
    const { data: kit, error } = await supabase
      .from("kits")
      .insert({ user_id: userId, nome: body.nome, preco_venda: body.preco_venda, quantidade_montada: 0, ativo: true })
      .select("id")
      .single();
    if (error) throw erroSupabase(error);

    if (body.itens.length > 0) {
      const linhas = body.itens.map((i) => ({ kit_id: kit.id, item_estoque_id: i.item_estoque_id, quantidade: i.quantidade }));
      const { error: erroItens } = await supabase.from("kit_itens").insert(linhas);
      if (erroItens) throw erroSupabase(erroItens);
    }
  },

  async editar(id: string, body: Partial<KitBody>): Promise<void> {
    await buscarKit(id);

    const patch: Record<string, unknown> = {};
    if (body.nome !== undefined) patch["nome"] = body.nome;
    if (body.preco_venda !== undefined) patch["preco_venda"] = body.preco_venda;
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("kits").update(patch).eq("id", id);
      if (error) throw erroSupabase(error);
    }

    if (body.itens !== undefined) {
      const { error: erroExcluir } = await supabase.from("kit_itens").delete().eq("kit_id", id);
      if (erroExcluir) throw erroSupabase(erroExcluir);
      if (body.itens.length > 0) {
        const linhas = body.itens.map((i) => ({ kit_id: id, item_estoque_id: i.item_estoque_id, quantidade: i.quantidade }));
        const { error: erroInserir } = await supabase.from("kit_itens").insert(linhas);
        if (erroInserir) throw erroSupabase(erroInserir);
      }
    }
  },

  /** Soft delete (`ativo = false`) se o kit já tem venda ou montagem — apagar quebraria o histórico. */
  async excluir(id: string): Promise<void> {
    const kit = await buscarKit(id);

    const { data: vendas, error: erroVendas } = await supabase.from("kit_vendas").select("id").eq("kit_id", id).limit(1);
    if (erroVendas) throw erroSupabase(erroVendas);
    const jaTeveMovimento = (vendas && vendas.length > 0) || kit.quantidade_montada > 0;

    if (jaTeveMovimento) {
      const { error } = await supabase.from("kits").update({ ativo: false }).eq("id", id);
      if (error) throw erroSupabase(error);
    } else {
      const { error: erroItens } = await supabase.from("kit_itens").delete().eq("kit_id", id);
      if (erroItens) throw erroSupabase(erroItens);
      const { error } = await supabase.from("kits").delete().eq("id", id);
      if (error) throw erroSupabase(error);
    }
  },

  /**
   * Consome insumo e incrementa `quantidade_montada`. Passa pelo aviso de A5:
   * sem `confirmarEstoqueInsuficiente`, falta de insumo devolve
   * `409 ESTOQUE_INSUFICIENTE` sem gravar nada.
   */
  async montar(id: string, quantidade: number, confirmarEstoqueInsuficiente = false): Promise<void> {
    const userId = await usuarioAtual();
    await buscarKit(id);

    const { data: composicao, error: erroComposicao } = await supabase
      .from("kit_itens")
      .select("item_estoque_id, quantidade")
      .eq("kit_id", id);
    if (erroComposicao) throw erroSupabase(erroComposicao);
    if (!composicao || composicao.length === 0) {
      throw new ApiError(422, "VALIDACAO_INVALIDA", "Kit sem composição cadastrada.");
    }

    const idsItem = composicao.map((c) => c.item_estoque_id as string);
    const { data: itensRows, error: erroItens } = await supabase
      .from("estoque_itens")
      .select("id, nome, unidade, quantidade_atual, custo_medio")
      .in("id", idsItem);
    if (erroItens) throw erroSupabase(erroItens);
    const itensEstoque = new Map<string, ItemEstoqueSaldo>();
    for (const i of itensRows ?? []) {
      itensEstoque.set(i.id as string, {
        id: i.id as string,
        nome: i.nome as string,
        unidade: i.unidade as string,
        quantidade_atual: Number(i.quantidade_atual),
        custo_medio: Number(i.custo_medio),
      });
    }

    const faltantes: FaltanteEstoque[] = [];
    for (const c of composicao) {
      const necessario = Number(c.quantidade) * quantidade;
      const item = itensEstoque.get(c.item_estoque_id as string)!;
      if (item.quantidade_atual < necessario) {
        faltantes.push({
          item_estoque_id: item.id,
          nome: item.nome,
          unidade: item.unidade,
          quantidade_solicitada: necessario,
          quantidade_disponivel: item.quantidade_atual,
          deficit: necessario - item.quantidade_atual,
        });
      }
    }

    if (faltantes.length > 0 && !confirmarEstoqueInsuficiente) {
      throw estoqueInsuficiente(faltantes);
    }

    // Decremento atômico primeiro — operação só é gravada como sucesso se
    // todos os itens da composição forem baixados; senão desfaz o que já
    // tinha decrementado nesta chamada (mesmo padrão de atendimentos.finalizar).
    const decrementados: { itemId: string; quantidade: number }[] = [];
    for (const c of composicao) {
      const itemId = c.item_estoque_id as string;
      const necessario = Number(c.quantidade) * quantidade;
      const resultado = await ajustarEstoque(itemId, -necessario, confirmarEstoqueInsuficiente);
      if (resultado === null) {
        for (const d of decrementados) await ajustarEstoque(d.itemId, d.quantidade, true);
        const item = itensEstoque.get(itemId)!;
        const { data: atual } = await supabase.from("estoque_itens").select("quantidade_atual").eq("id", itemId).maybeSingle();
        const disponivel = Number(atual?.quantidade_atual ?? item.quantidade_atual);
        throw estoqueInsuficiente([
          {
            item_estoque_id: item.id,
            nome: item.nome,
            unidade: item.unidade,
            quantidade_solicitada: necessario,
            quantidade_disponivel: disponivel,
            deficit: necessario - disponivel,
          },
        ]);
      }
      decrementados.push({ itemId, quantidade: necessario });
    }

    for (const c of composicao) {
      const itemId = c.item_estoque_id as string;
      const necessario = Number(c.quantidade) * quantidade;
      const item = itensEstoque.get(itemId)!;
      const { error } = await supabase.from("estoque_movimentacoes").insert({
        user_id: userId,
        item_id: itemId,
        tipo: "saida",
        quantidade: necessario,
        motivo: "Montagem de kit",
        custo_unitario: item.custo_medio,
        kit_id: id,
        forcada: faltantes.some((f) => f.item_estoque_id === itemId),
      });
      if (error) throw erroSupabase(error);
    }

    // O saldo de insumo já passou pelo RPC atômico acima — o único ponto sem
    // trava de corrida é este `quantidade_montada += quantidade`. Não existe
    // hoje uma RPC dedicada para kit (só a de estoque, `ajustar_estoque`); a
    // janela de corrida entre duas montagens do mesmo kit ao mesmo tempo é bem
    // mais estreita que a de estoque (não depende de câmera bipando em série).
    const kitAtual = await buscarKit(id);
    const { error: erroUpdate } = await supabase
      .from("kits")
      .update({ quantidade_montada: kitAtual.quantidade_montada + quantidade })
      .eq("id", id);
    if (erroUpdate) throw erroSupabase(erroUpdate);
  },

  /**
   * Decrementa `quantidade_montada` e grava a venda com snapshot de preço e custo.
   *
   * **Sem segunda passada**: `KIT_NAO_MONTADO` é definitivo. Estoque negativo
   * representa consumo que já aconteceu; um kit que não existe não se vende.
   */
  async vender(
    id: string,
    body: { quantidade: number; forma_pagamento: FormaPagamento; preco_unitario?: number; data?: string },
  ): Promise<void> {
    const userId = await usuarioAtual();
    const kit = await buscarKit(id);

    if (kit.quantidade_montada < body.quantidade) {
      throw kitNaoMontado(kit.quantidade_montada, body.quantidade);
    }

    const { data: itensRows, error: erroItens } = await supabase
      .from("kit_itens")
      .select("item_estoque_id, quantidade, estoque_itens(custo_medio)")
      .eq("kit_id", id);
    if (erroItens) throw erroSupabase(erroItens);
    const custoTotal = (itensRows ?? []).reduce((soma, linha) => {
      const item = linha.estoque_itens as unknown as { custo_medio: number } | null;
      return soma + Number(linha.quantidade) * Number(item?.custo_medio ?? 0);
    }, 0);

    const precoUnitario = body.preco_unitario ?? Number(kit.preco_venda);

    const { error: erroUpdate } = await supabase
      .from("kits")
      .update({ quantidade_montada: kit.quantidade_montada - body.quantidade })
      .eq("id", id);
    if (erroUpdate) throw erroSupabase(erroUpdate);

    const { error: erroVenda } = await supabase.from("kit_vendas").insert({
      user_id: userId,
      kit_id: id,
      quantidade: body.quantidade,
      nome_snapshot: kit.nome,
      preco_unitario: precoUnitario,
      custo_snapshot: custoTotal,
      forma_pagamento: body.forma_pagamento,
      data: body.data ?? new Date().toISOString(),
    });
    if (erroVenda) throw erroSupabase(erroVenda);
  },
} as const;
