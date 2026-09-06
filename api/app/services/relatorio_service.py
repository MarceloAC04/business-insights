"""
Serviço de resumo mensal.

Espelha exatamente a conta que `frontend/salao_web/src/lib/api/resumo.ts` fazia
no cliente (branch `feat/react-supabase`, já verificada ponta a ponta contra o
Supabase real) — mesma fórmula, fonte dos dados diferente (aqui via `service_role`
no Postgres, lá via `anon` + RLS). Ver `.specs/00-ENTREGA-BACKEND.md` § resumo e
regra de negócio 5 (kit no resumo).

Regras:
  - entrou              = total_servicos + total_kits
  - saiu                = total_custos_fixos + total_gastos_variaveis
  - saldo_final          = entrou - saiu
  - custo_kits_vendidos  é informativo — já saiu quando o insumo foi comprado,
    não entra em `saiu` de novo (senão é o mesmo dinheiro contado duas vezes)
  - gasto de categoria 'fixo' não entra em total_gastos_variaveis — seria o
    mesmo custo fixo do perfil contado de novo
  - custos fixos só contam num mês se já existiam até o fim dele (criado_em <
    início do mês seguinte) — um custo fixo cadastrado hoje não pode "aparecer"
    retroativo no histórico de meses passados
  - alerta_zero_a_zero é True quando entrou > 0 e 0 <= saldo_final < limite da
    usuária (`alerta_preferencias.limite_saldo_alerta`)
"""

from collections import defaultdict
from dataclasses import dataclass, field

from supabase import Client

from app.core.supabase_client import rows
from app.schemas.relatorio import (
    PontoHistorico,
    ResumoGastos,
    ResumoInsights,
    ResumoMensal,
    ResumoReceita,
    ServicoMaisLucrativo,
    ServicoRanking,
)


@dataclass
class _MesCalculado:
    entrou: float = 0.0
    saiu: float = 0.0
    custos_fixos: float = 0.0
    total_servicos: float = 0.0
    total_insumos: float = 0.0
    quantidade_atendimentos: int = 0
    total_kits: float = 0.0
    quantidade_kits: int = 0
    custo_kits: float = 0.0
    ranking: list[ServicoRanking] = field(default_factory=list)


def _primeiro_dia(ano: int, mes: int) -> str:
    return f"{ano:04d}-{mes:02d}-01"


def _deslocar_mes(ano: int, mes: int, offset: int) -> tuple[int, int]:
    """Mesmo mês/ano deslocado por `offset` meses (pode ser negativo)."""
    indice = (ano * 12 + (mes - 1)) + offset
    return indice // 12, indice % 12 + 1


def _custos_fixos_ate_mes(linhas: list[dict], fim_exclusivo: str) -> float:
    return sum(
        float(c["valor"]) for c in linhas if str(c["criado_em"]) < fim_exclusivo
    )


def _construir_ranking(
    atendimentos: list[dict], total_servicos: float, total_insumos: float
) -> list[ServicoRanking]:
    """Ranking por nome do serviço — serviço avulso (sem servico_id) também conta."""
    quantidade: dict[str, int] = defaultdict(int)
    receita: dict[str, float] = defaultdict(float)
    for atendimento in atendimentos:
        for servico in atendimento.get("atendimento_servicos") or []:
            nome = str(servico["nome_servico"])
            quantidade[nome] += 1
            receita[nome] += float(servico["preco_snapshot"])

    ranking = sorted(
        (
            ServicoRanking(nome=nome, quantidade=quantidade[nome], total_receita=round(valor, 2))
            for nome, valor in receita.items()
        ),
        key=lambda s: s.total_receita,
        reverse=True,
    )
    for servico in ranking:
        custo_rateado = (
            0.0 if total_servicos == 0 else total_insumos * (servico.total_receita / total_servicos)
        )
        servico.lucro = round(servico.total_receita - custo_rateado, 2)
    return ranking


def _calcular_mes(
    supabase: Client, user_id: str, ano: int, mes: int, custos_fixos_rows: list[dict]
) -> _MesCalculado:
    inicio = _primeiro_dia(ano, mes)
    fim_ano, fim_mes = _deslocar_mes(ano, mes, 1)
    fim = _primeiro_dia(fim_ano, fim_mes)
    custos_fixos = _custos_fixos_ate_mes(custos_fixos_rows, fim)

    resp_atend = (
        supabase.table("atendimentos")
        .select("id, atendimento_servicos(nome_servico, preco_snapshot), atendimento_insumos(preco)")
        .eq("user_id", user_id)
        .eq("status", "finalizado")
        .gte("data", inicio)
        .lt("data", fim)
        .execute()
    )
    resp_kits = (
        supabase.table("kit_vendas")
        .select("quantidade, preco_unitario, custo_snapshot")
        .eq("user_id", user_id)
        .gte("data", inicio)
        .lt("data", fim)
        .execute()
    )
    resp_gastos = (
        supabase.table("gastos")
        .select("valor")
        .eq("user_id", user_id)
        .neq("categoria", "fixo")
        .gte("prazo", inicio)
        .lt("prazo", fim)
        .execute()
    )

    finalizados = rows(resp_atend.data)
    total_servicos = sum(
        float(s["preco_snapshot"])
        for a in finalizados
        for s in (a.get("atendimento_servicos") or [])
    )
    total_insumos = sum(
        float(i["preco"]) for a in finalizados for i in (a.get("atendimento_insumos") or [])
    )
    ranking = _construir_ranking(finalizados, total_servicos, total_insumos)

    vendas = rows(resp_kits.data)
    total_kits = sum(float(v["quantidade"]) * float(v["preco_unitario"]) for v in vendas)
    quantidade_kits = sum(int(v["quantidade"]) for v in vendas)
    custo_kits = sum(float(v["quantidade"]) * float(v["custo_snapshot"]) for v in vendas)

    total_variaveis = sum(float(g["valor"]) for g in rows(resp_gastos.data))

    entrou = total_servicos + total_kits
    saiu = custos_fixos + total_variaveis

    return _MesCalculado(
        entrou=entrou,
        saiu=saiu,
        custos_fixos=custos_fixos,
        total_servicos=total_servicos,
        total_insumos=total_insumos,
        quantidade_atendimentos=len(finalizados),
        total_kits=total_kits,
        quantidade_kits=quantidade_kits,
        custo_kits=custo_kits,
        ranking=ranking,
    )


async def calcular_resumo_mensal(
    supabase: Client,
    user_id: str,
    ano: int,
    mes: int,
) -> ResumoMensal:
    resp_fixos = (
        supabase.table("custos_fixos").select("valor, criado_em").eq("user_id", user_id).execute()
    )
    custos_fixos_rows = rows(resp_fixos.data)

    resp_perfil = (
        supabase.table("perfil_salao")
        .select("meta_faturamento_mensal")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    resp_pref = (
        supabase.table("alerta_preferencias")
        .select("limite_saldo_alerta")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    meta = float((resp_perfil.data or {}).get("meta_faturamento_mensal") or 9000)
    limite = float((resp_pref.data or {}).get("limite_saldo_alerta") or 0)

    # Seis pontos cronológicos terminando no mês pedido — o último é o mês que
    # a tela está mostrando, e por isso reaproveitamos o detalhe dele abaixo.
    meses = [_deslocar_mes(ano, mes, offset) for offset in range(-5, 1)]
    resultados = [
        _calcular_mes(supabase, user_id, m_ano, m_mes, custos_fixos_rows) for m_ano, m_mes in meses
    ]

    atual = resultados[5]
    anterior_resultado = resultados[4]
    anterior = anterior_resultado.entrou - anterior_resultado.saiu
    saldo_final = atual.entrou - atual.saiu

    historico = [
        PontoHistorico(ano=m_ano, mes=m_mes, receitas=resultados[i].entrou, despesas=resultados[i].saiu)
        for i, (m_ano, m_mes) in enumerate(meses)
    ]

    primeiro = atual.ranking[0] if atual.ranking else None

    return ResumoMensal(
        ano=ano,
        mes=mes,
        saldo_final=round(saldo_final, 2),
        entrou=round(atual.entrou, 2),
        saiu=round(atual.saiu, 2),
        meta_faturamento_mensal=meta,
        historico_seis_meses=historico,
        receita=ResumoReceita(
            total_servicos=round(atual.total_servicos, 2),
            total_insumos=round(atual.total_insumos, 2),
            liquido_atendimentos=round(atual.total_servicos - atual.total_insumos, 2),
            quantidade_atendimentos=atual.quantidade_atendimentos,
            total_kits=round(atual.total_kits, 2),
            quantidade_kits_vendidos=atual.quantidade_kits,
            custo_kits_vendidos=round(atual.custo_kits, 2),
            servicos_mais_realizados=atual.ranking[:5],
        ),
        gastos=ResumoGastos(
            total_custos_fixos=round(atual.custos_fixos, 2),
            total_gastos_variaveis=round(atual.saiu - atual.custos_fixos, 2),
            total_saiu=round(atual.saiu, 2),
        ),
        insights=ResumoInsights(
            # Kit não é atendimento e diluiria o ticket que ela usa para precificar.
            ticket_medio=round(
                0.0 if atual.quantidade_atendimentos == 0
                else atual.total_servicos / atual.quantidade_atendimentos,
                2,
            ),
            margem_lucro_percentual=round(
                0.0 if atual.entrou == 0 else (saldo_final / atual.entrou) * 100, 2
            ),
            variacao_percentual_mes_anterior=round(
                0.0 if anterior == 0 else ((saldo_final - anterior) / abs(anterior)) * 100, 2
            ),
            saldo_mes_anterior=round(anterior, 2),
            servico_mais_lucrativo=(
                ServicoMaisLucrativo(nome=primeiro.nome, lucro=primeiro.total_receita)
                if primeiro
                else None
            ),
        ),
        # Trabalhou o mês e sobrou quase nada: o "zero a zero" do protótipo.
        alerta_zero_a_zero=atual.entrou > 0 and 0 <= saldo_final < limite,
    )
