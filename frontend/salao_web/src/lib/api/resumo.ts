import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { PontoHistorico, ResumoMensal, ServicoRealizado } from "../types";

/**
 * `resumo` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * A conta inteira mora aqui, no cliente: sem regra atômica ou privilégio de
 * `service_role` envolvidos, é só leitura + soma (mesmo padrão de
 * `w4lle-tv`/`catalogo_dvds` — cliente fala direto com o Supabase, RLS barra o
 * que não é dela). A lógica é o espelho do que `demo-database.ts` já fazia
 * (`private resumo(...)`) — mesma conta, fonte dos dados diferente.
 */

export interface PrecificacaoBody {
  custo_material: number;
  tempo_minutos: number;
  meta_hora: number;
  percentual_overhead?: number;
  percentual_lucro?: number;
}

export interface Precificacao {
  custo_material: number;
  custo_tempo: number;
  custo_overhead: number;
  custo_total: number;
  preco_minimo: number;
  preco_sugerido: number;
  cobrindo_custos: boolean | null;
  diferenca: number | null;
}

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

/** `AAAA-MM-01`, primeiro dia do mês — limite inclusivo de início do período. */
function primeiroDia(ano: number, mes: number): string {
  return `${ano}-${String(mes).padStart(2, "0")}-01`;
}

/** Mesmo mês/ano deslocado por `offset` meses (pode ser negativo). */
function deslocarMes(ano: number, mes: number, offset: number): { ano: number; mes: number } {
  const data = new Date(ano, mes - 1 + offset, 1);
  return { ano: data.getFullYear(), mes: data.getMonth() + 1 };
}

interface AtendimentoFinalizadoRow {
  atendimento_servicos: { nome_servico: string; preco_snapshot: number }[] | null;
  atendimento_insumos: { preco: number }[] | null;
}

/** Ranking por nome do serviço — serviço avulso (sem `servico_id`) também conta. */
function construirRanking(
  finalizados: AtendimentoFinalizadoRow[],
  totalServicos: number,
  totalInsumos: number,
): ServicoRealizado[] {
  const ranking = new Map<string, ServicoRealizado>();
  for (const atendimento of finalizados) {
    for (const servico of atendimento.atendimento_servicos ?? []) {
      const linha = ranking.get(servico.nome_servico) ?? {
        nome: servico.nome_servico,
        quantidade: 0,
        total_receita: 0,
        lucro: 0,
      };
      linha.quantidade += 1;
      linha.total_receita += Number(servico.preco_snapshot);
      ranking.set(servico.nome_servico, linha);
    }
  }
  const lista = [...ranking.values()].sort((a, b) => b.total_receita - a.total_receita);
  for (const servico of lista) {
    const custoRateado =
      totalServicos === 0 ? 0 : totalInsumos * (servico.total_receita / totalServicos);
    servico.lucro = servico.total_receita - custoRateado;
  }
  return lista;
}

interface MesCalculado {
  entrou: number;
  saiu: number;
  custosFixos: number;
  totalServicos: number;
  totalInsumos: number;
  quantidadeAtendimentos: number;
  totalKits: number;
  quantidadeKits: number;
  custoKits: number;
  ranking: ServicoRealizado[];
}

interface CustoFixoRow {
  valor: number;
  criado_em: string;
}

/**
 * Soma só os custos fixos que já existiam até o fim do mês pedido — um custo
 * fixo cadastrado hoje não pode "aparecer" retroativo em abril. Sem isso, o
 * histórico de 6 meses mostraria o aluguel pesando em meses que ainda nem
 * tinham esse compromisso (divergia do `demo-database.ts`, corrigido depois
 * de checar com o dono do projeto).
 */
function custosFixosAteMes(linhas: CustoFixoRow[], fimExclusivo: string): number {
  return linhas
    .filter((c) => c.criado_em < fimExclusivo)
    .reduce((soma, c) => soma + Number(c.valor), 0);
}

/**
 * Toda a conta de um mês em um lugar — mesmo papel do `private resumo(...)`
 * do modo demo. `custosFixosRows` vem de fora (uma leitura só para os 6
 * meses) porque cada mês precisa ver só quem já existia até ali.
 */
async function calcularMes(
  ano: number,
  mes: number,
  custosFixosRows: CustoFixoRow[],
): Promise<MesCalculado> {
  const inicio = primeiroDia(ano, mes);
  const fim = primeiroDia(deslocarMes(ano, mes, 1).ano, deslocarMes(ano, mes, 1).mes);
  const custosFixos = custosFixosAteMes(custosFixosRows, fim);

  const [atendimentosRes, kitsRes, gastosRes] = await Promise.all([
    supabase
      .from("atendimentos")
      .select("id, atendimento_servicos(nome_servico, preco_snapshot), atendimento_insumos(preco)")
      .eq("status", "finalizado")
      .gte("data", inicio)
      .lt("data", fim),
    supabase.from("kit_vendas").select("quantidade, preco_unitario, custo_snapshot").gte("data", inicio).lt("data", fim),
    supabase.from("gastos").select("valor").neq("categoria", "fixo").gte("prazo", inicio).lt("prazo", fim),
  ]);

  if (atendimentosRes.error) throw erroSupabase(atendimentosRes.error);
  if (kitsRes.error) throw erroSupabase(kitsRes.error);
  if (gastosRes.error) throw erroSupabase(gastosRes.error);

  const finalizados = (atendimentosRes.data ?? []) as unknown as AtendimentoFinalizadoRow[];
  const totalServicos = finalizados.reduce(
    (soma, a) =>
      soma + (a.atendimento_servicos ?? []).reduce((s, sv) => s + Number(sv.preco_snapshot), 0),
    0,
  );
  const totalInsumos = finalizados.reduce(
    (soma, a) => soma + (a.atendimento_insumos ?? []).reduce((s, it) => s + Number(it.preco), 0),
    0,
  );
  const ranking = construirRanking(finalizados, totalServicos, totalInsumos);

  const vendas = kitsRes.data ?? [];
  const totalKits = vendas.reduce((soma, v) => soma + v.quantidade * Number(v.preco_unitario), 0);
  const quantidadeKits = vendas.reduce((soma, v) => soma + v.quantidade, 0);
  const custoKits = vendas.reduce((soma, v) => soma + v.quantidade * Number(v.custo_snapshot), 0);

  const totalVariaveis = (gastosRes.data ?? []).reduce((soma, g) => soma + Number(g.valor), 0);

  // Kit é receita e entra no `entrou`; o custo dele não entra no `saiu` — já
  // saiu quando o insumo foi comprado. Custo fixo é o compromisso do perfil:
  // o gasto de categoria `fixo` seria o mesmo aluguel contado duas vezes.
  const entrou = totalServicos + totalKits;
  const saiu = custosFixos + totalVariaveis;

  return {
    entrou,
    saiu,
    custosFixos,
    totalServicos,
    totalInsumos,
    quantidadeAtendimentos: finalizados.length,
    totalKits,
    quantidadeKits,
    custoKits,
    ranking,
  };
}

async function buscarCustosFixos(): Promise<CustoFixoRow[]> {
  const { data, error } = await supabase.from("custos_fixos").select("valor, criado_em");
  if (error) throw erroSupabase(error);
  return data ?? [];
}

export const ResumoApi = {
  async mensal({ ano, mes }: { ano: number; mes: number }): Promise<ResumoMensal> {
    const [custosFixosRows, metaRes, limiteRes] = await Promise.all([
      buscarCustosFixos(),
      supabase.from("perfil_salao").select("meta_faturamento_mensal").maybeSingle(),
      supabase.from("alerta_preferencias").select("limite_saldo_alerta").maybeSingle(),
    ]);
    if (metaRes.error) throw erroSupabase(metaRes.error);
    if (limiteRes.error) throw erroSupabase(limiteRes.error);

    // Seis pontos cronológicos terminando no mês pedido — o último é o mês
    // que a tela está mostrando, e por isso reaproveitamos o detalhe dele em
    // vez de buscar de novo.
    const meses = Array.from({ length: 6 }, (_, i) => deslocarMes(ano, mes, i - 5));
    const resultados = await Promise.all(
      meses.map((m) => calcularMes(m.ano, m.mes, custosFixosRows)),
    );

    const atual = resultados[5]!;
    const anteriorResultado = resultados[4]!;
    const anterior = anteriorResultado.entrou - anteriorResultado.saiu;
    const saldoFinal = atual.entrou - atual.saiu;

    const historico: PontoHistorico[] = meses.map((m, i) => ({
      ano: m.ano,
      mes: m.mes,
      receitas: resultados[i]!.entrou,
      despesas: resultados[i]!.saiu,
    }));

    const meta = Number(metaRes.data?.["meta_faturamento_mensal"] ?? 9000);
    const limite = Number(limiteRes.data?.["limite_saldo_alerta"] ?? 0);
    const primeiro = atual.ranking[0];

    return {
      ano,
      mes,
      saldo_final: saldoFinal,
      entrou: atual.entrou,
      saiu: atual.saiu,
      meta_faturamento_mensal: meta,
      historico_seis_meses: historico,
      receita: {
        total_servicos: atual.totalServicos,
        total_insumos: atual.totalInsumos,
        liquido_atendimentos: atual.totalServicos - atual.totalInsumos,
        quantidade_atendimentos: atual.quantidadeAtendimentos,
        total_kits: atual.totalKits,
        quantidade_kits_vendidos: Math.trunc(atual.quantidadeKits),
        custo_kits_vendidos: atual.custoKits,
        servicos_mais_realizados: atual.ranking.slice(0, 5),
      },
      gastos: {
        total_custos_fixos: atual.custosFixos,
        total_gastos_variaveis: atual.saiu - atual.custosFixos,
        total_saiu: atual.saiu,
      },
      insights: {
        // Kit não é atendimento e diluiria o ticket que ela usa para precificar.
        ticket_medio:
          atual.quantidadeAtendimentos === 0 ? 0 : atual.totalServicos / atual.quantidadeAtendimentos,
        margem_lucro_percentual: atual.entrou === 0 ? 0 : (saldoFinal / atual.entrou) * 100,
        variacao_percentual_mes_anterior:
          anterior === 0 ? 0 : ((saldoFinal - anterior) / Math.abs(anterior)) * 100,
        saldo_mes_anterior: anterior,
        servico_mais_lucrativo: primeiro ? { nome: primeiro.nome, lucro: primeiro.total_receita } : null,
      },
      // Trabalhou o mês e sobrou quase nada: o "zero a zero" do protótipo.
      alerta_zero_a_zero: atual.entrou > 0 && saldoFinal >= 0 && saldoFinal < limite,
    };
  },

  /** Cálculo puro: não toca no banco, então não precisa do Supabase. */
  calcularPreco(body: PrecificacaoBody, precoAtual?: number): Promise<Precificacao> {
    const custoMaterial = body.custo_material;
    const tempoMinutos = body.tempo_minutos;
    const metaHora = body.meta_hora;
    const overhead = body.percentual_overhead ?? 0.15;
    const lucro = body.percentual_lucro ?? 0.2;

    const custoTempo = metaHora * (tempoMinutos / 60);
    const custoOverhead = (custoMaterial + custoTempo) * overhead;
    const custoTotal = custoMaterial + custoTempo + custoOverhead;
    const precoMinimo = custoTotal * (1 + lucro);
    const precoAtualOuNulo = precoAtual ?? null;

    return Promise.resolve({
      custo_material: custoMaterial,
      custo_tempo: custoTempo,
      custo_overhead: custoOverhead,
      custo_total: custoTotal,
      preco_minimo: precoMinimo,
      preco_sugerido: Math.ceil(precoMinimo / 5) * 5,
      cobrindo_custos: precoAtualOuNulo === null ? null : precoAtualOuNulo >= custoTotal,
      diferenca: precoAtualOuNulo === null ? null : precoAtualOuNulo - precoMinimo,
    });
  },
} as const;
