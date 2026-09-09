"""
Testes unitários do serviço de resumo mensal.

O Supabase é mockado para que os testes rodem sem banco de dados.
Cada teste valida uma regra de negócio específica de `.specs/00-ENTREGA-BACKEND.md`
§ resumo — o serviço espelha a conta que `frontend/salao_web/src/lib/api/resumo.ts`
fazia no cliente (branch `feat/react-supabase`), então calcula os seis meses do
histórico, não só o mês pedido.

Rodar com: pytest tests/test_relatorio_service.py -v
"""

import pytest
from unittest.mock import MagicMock
from app.services.relatorio_service import calcular_resumo_anual, calcular_resumo_mensal


# ── Helpers de mock ─────────────────────────────────────────────────

def _iso(ano: int, mes: int) -> str:
    return f"{ano:04d}-{mes:02d}-01"


def _chain_mensal(datasets_por_inicio: dict[str, list] | None = None):
    """
    Mock de uma tabela filtrada por `.gte(campo, inicio).lt(campo, fim)`
    (atendimentos, kit_vendas, gastos) — cada mês do histórico dispara sua
    própria query, então o retorno depende de qual `inicio` foi passado.
    Mês não mapeado em `datasets_por_inicio` devolve lista vazia.
    """
    datasets = datasets_por_inicio or {}
    estado = {"inicio": None}
    chain = MagicMock()

    def gte(_campo, valor):
        estado["inicio"] = valor
        return chain

    def execute():
        resp = MagicMock()
        resp.data = datasets.get(estado["inicio"], [])
        return resp

    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.neq.return_value = chain
    chain.lt.return_value = chain
    chain.gte.side_effect = gte
    chain.execute.side_effect = execute
    return chain


def _chain_fixo(data):
    """Mock de uma tabela sem filtro de data (custos_fixos)."""
    chain = MagicMock()
    resp = MagicMock()
    resp.data = data
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.execute.return_value = resp
    return chain


def _chain_single(data: dict | None):
    """Mock de `.select(...).eq(...).maybe_single().execute()` (perfil/preferências)."""
    chain = MagicMock()
    resp = MagicMock()
    resp.data = data
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.maybe_single.return_value = chain
    chain.execute.return_value = resp
    return chain


def mock_supabase(
    atendimentos_por_inicio: dict[str, list] | None = None,
    kit_vendas_por_inicio: dict[str, list] | None = None,
    gastos_por_inicio: dict[str, list] | None = None,
    custos_fixos: list | None = None,
    meta_faturamento_mensal: float | None = None,
    limite_saldo_alerta: float | None = None,
):
    tabelas = {
        "atendimentos": _chain_mensal(atendimentos_por_inicio),
        "kit_vendas": _chain_mensal(kit_vendas_por_inicio),
        "gastos": _chain_mensal(gastos_por_inicio),
        "custos_fixos": _chain_fixo(custos_fixos or []),
        "perfil_salao": _chain_single(
            {"meta_faturamento_mensal": meta_faturamento_mensal} if meta_faturamento_mensal is not None else None
        ),
        "alerta_preferencias": _chain_single(
            {"limite_saldo_alerta": limite_saldo_alerta} if limite_saldo_alerta is not None else None
        ),
    }
    client = MagicMock()
    client.table.side_effect = lambda nome: tabelas[nome]
    return client


# ── Fixtures ────────────────────────────────────────────────────────

USER_ID = "user-123"
ANO = 2025
MES = 5
INICIO_MES = _iso(ANO, MES)


# ── Testes ──────────────────────────────────────────────────────────

class TestCalculoResumoMensal:

    @pytest.mark.asyncio
    async def test_saldo_positivo_simples(self):
        """Serviços cobrem gastos → saldo positivo; sem limite configurado, sem alerta."""
        sb = mock_supabase(
            atendimentos_por_inicio={
                INICIO_MES: [
                    {
                        "id": "a1",
                        "atendimento_servicos": [{"nome_servico": "Extensão de cílios", "preco_snapshot": 180.0}],
                        "atendimento_insumos": [{"preco": 20.0}],
                    }
                ]
            },
            custos_fixos=[{"valor": 100.0, "criado_em": "2020-01-01"}],
            gastos_por_inicio={INICIO_MES: [{"valor": 50.0}]},
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)

        # líquido_atendimentos = 180 - 20 = 160; entrou = 160 + kits(0) = ... entrou = total_servicos = 180
        assert resumo.receita.liquido_atendimentos == 160.0
        assert resumo.gastos.total_saiu == 150.0
        # entrou = total_servicos (180) + total_kits (0); saiu = 150 → saldo = 30
        assert resumo.saldo_final == 30.0
        assert resumo.entrou == 180.0

    @pytest.mark.asyncio
    async def test_alerta_zero_a_zero_ativado_dentro_do_limite(self):
        """entrou > 0 e 0 <= saldo_final < limite → alerta ligado."""
        sb = mock_supabase(
            atendimentos_por_inicio={
                INICIO_MES: [
                    {
                        "id": "a1",
                        "atendimento_servicos": [{"nome_servico": "Limpeza de pele", "preco_snapshot": 150.0}],
                        "atendimento_insumos": [{"preco": 10.0}],
                    }
                ]
            },
            custos_fixos=[{"valor": 120.0, "criado_em": "2020-01-01"}],
            gastos_por_inicio={INICIO_MES: [{"valor": 15.0}]},
            limite_saldo_alerta=20.0,
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        # entrou = 150; saiu = 135; saldo = 15 (dentro do limite de 20)
        assert resumo.saldo_final == 15.0
        assert resumo.alerta_zero_a_zero is True

    @pytest.mark.asyncio
    async def test_alerta_zero_a_zero_desativado_quando_saldo_acima_do_limite(self):
        sb = mock_supabase(
            atendimentos_por_inicio={
                INICIO_MES: [
                    {
                        "id": "a1",
                        "atendimento_servicos": [{"nome_servico": "Extensão de cílios", "preco_snapshot": 180.0}],
                        "atendimento_insumos": [{"preco": 20.0}],
                    },
                    {
                        "id": "a2",
                        "atendimento_servicos": [{"nome_servico": "Extensão de cílios", "preco_snapshot": 180.0}],
                        "atendimento_insumos": [{"preco": 20.0}],
                    },
                ]
            },
            custos_fixos=[{"valor": 100.0, "criado_em": "2020-01-01"}],
            gastos_por_inicio={INICIO_MES: [{"valor": 50.0}]},
            limite_saldo_alerta=20.0,
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.saldo_final == 210.0
        assert resumo.alerta_zero_a_zero is False

    @pytest.mark.asyncio
    async def test_alerta_desativado_quando_saldo_negativo(self):
        """Saldo negativo não dispara o alerta de zero a zero — esse é outro problema."""
        sb = mock_supabase(
            atendimentos_por_inicio={
                INICIO_MES: [
                    {
                        "id": "a1",
                        "atendimento_servicos": [{"nome_servico": "Sobrancelha", "preco_snapshot": 60.0}],
                        "atendimento_insumos": [],
                    }
                ]
            },
            custos_fixos=[{"valor": 1200.0, "criado_em": "2020-01-01"}],
            gastos_por_inicio={INICIO_MES: [{"valor": 200.0}]},
            limite_saldo_alerta=9999.0,
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.saldo_final < 0
        assert resumo.alerta_zero_a_zero is False

    @pytest.mark.asyncio
    async def test_sem_atendimentos_no_mes(self):
        sb = mock_supabase(
            custos_fixos=[{"valor": 1200.0, "criado_em": "2020-01-01"}],
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.receita.quantidade_atendimentos == 0
        assert resumo.receita.total_servicos == 0.0
        assert resumo.saldo_final == -1200.0

    @pytest.mark.asyncio
    async def test_ranking_por_receita_e_lucro_rateado(self):
        """Ranking ordena por receita (não por quantidade) e rateia o custo de insumos."""
        sb = mock_supabase(
            atendimentos_por_inicio={
                INICIO_MES: [
                    {
                        "id": "a1",
                        "atendimento_servicos": [{"nome_servico": "Extensão de cílios", "preco_snapshot": 180.0}],
                        "atendimento_insumos": [{"preco": 20.0}],
                    },
                    {
                        "id": "a2",
                        "atendimento_servicos": [{"nome_servico": "Limpeza de pele", "preco_snapshot": 150.0}],
                        "atendimento_insumos": [{"preco": 10.0}],
                    },
                ]
            },
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        ranking = resumo.receita.servicos_mais_realizados
        assert ranking[0].nome == "Extensão de cílios"
        assert ranking[1].nome == "Limpeza de pele"
        # total_insumos = 30; rateado por receita: cílios 180/330*30=16.36; limpeza 150/330*30=13.64
        assert ranking[0].lucro == pytest.approx(180.0 - 30.0 * (180 / 330), abs=0.01)
        assert ranking[1].lucro == pytest.approx(150.0 - 30.0 * (150 / 330), abs=0.01)

    @pytest.mark.asyncio
    async def test_custos_fixos_entram_no_total_saiu(self):
        sb = mock_supabase(
            custos_fixos=[
                {"valor": 1200.0, "criado_em": "2020-01-01"},
                {"valor": 99.0, "criado_em": "2020-01-01"},
                {"valor": 49.0, "criado_em": "2020-01-01"},
            ],
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.gastos.total_custos_fixos == 1348.0
        assert resumo.gastos.total_saiu == 1348.0

    @pytest.mark.asyncio
    async def test_custo_fixo_cadastrado_depois_nao_conta_retroativo(self):
        """Custo fixo criado DEPOIS do fim do mês pedido não pode aparecer nele."""
        sb = mock_supabase(
            custos_fixos=[
                {"valor": 1200.0, "criado_em": "2020-01-01"},
                {"valor": 300.0, "criado_em": _iso(ANO, MES + 1)},  # criado só no mês seguinte
            ],
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.gastos.total_custos_fixos == 1200.0

    @pytest.mark.asyncio
    async def test_gasto_categoria_fixo_nao_entra_em_variaveis(self):
        """Gasto de categoria 'fixo' já está contado em custos_fixos — não soma de novo."""
        sb = mock_supabase(
            gastos_por_inicio={INICIO_MES: [{"valor": 500.0}]},  # já vem filtrado por !=fixo no service
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.gastos.total_gastos_variaveis == 500.0

    @pytest.mark.asyncio
    async def test_kit_vendido_soma_em_entrou_mas_custo_nao_soma_em_saiu(self):
        """Regra 5 do backend: receita do kit entra em `entrou`; o custo do kit é só
        informativo — não entra em `saiu` (já saiu quando o insumo foi comprado)."""
        sb = mock_supabase(
            kit_vendas_por_inicio={
                INICIO_MES: [{"quantidade": 2, "preco_unitario": 40.0, "custo_snapshot": 15.0}]
            },
            custos_fixos=[{"valor": 100.0, "criado_em": "2020-01-01"}],
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.receita.total_kits == 80.0
        assert resumo.receita.quantidade_kits_vendidos == 2
        assert resumo.receita.custo_kits_vendidos == 30.0
        assert resumo.entrou == 80.0
        assert resumo.saiu == 100.0
        assert resumo.saldo_final == -20.0

    @pytest.mark.asyncio
    async def test_ticket_medio_ignora_kit(self):
        """Kit não é atendimento e diluiria o ticket usado pra precificar."""
        sb = mock_supabase(
            atendimentos_por_inicio={
                INICIO_MES: [
                    {
                        "id": "a1",
                        "atendimento_servicos": [{"nome_servico": "Sobrancelha", "preco_snapshot": 100.0}],
                        "atendimento_insumos": [],
                    }
                ]
            },
            kit_vendas_por_inicio={
                INICIO_MES: [{"quantidade": 1, "preco_unitario": 999.0, "custo_snapshot": 0}]
            },
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.insights.ticket_medio == 100.0

    @pytest.mark.asyncio
    async def test_historico_seis_meses_tem_seis_pontos_cronologicos(self):
        sb = mock_supabase(
            atendimentos_por_inicio={
                INICIO_MES: [
                    {
                        "id": "a1",
                        "atendimento_servicos": [{"nome_servico": "Sobrancelha", "preco_snapshot": 100.0}],
                        "atendimento_insumos": [],
                    }
                ]
            },
        )
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert len(resumo.historico_seis_meses) == 6
        assert resumo.historico_seis_meses[-1].ano == ANO
        assert resumo.historico_seis_meses[-1].mes == MES
        assert resumo.historico_seis_meses[-1].receitas == 100.0
        # meses anteriores sem dado mockado → zerados, não ausentes
        assert resumo.historico_seis_meses[0].receitas == 0.0

    @pytest.mark.asyncio
    async def test_meta_e_limite_usam_default_quando_perfil_sem_dado(self):
        sb = mock_supabase()
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.meta_faturamento_mensal == 9000.0

    @pytest.mark.asyncio
    async def test_meta_vem_do_perfil_quando_configurada(self):
        sb = mock_supabase(meta_faturamento_mensal=15000.0)
        resumo = await calcular_resumo_mensal(sb, USER_ID, ANO, MES)
        assert resumo.meta_faturamento_mensal == 15000.0


class TestCalculoResumoAnual:

    @pytest.mark.asyncio
    async def test_consolida_doze_meses_e_compara_com_ano_anterior(self):
        sb = mock_supabase(
            atendimentos_por_inicio={
                _iso(ANO - 1, 1): [
                    {
                        "id": "anterior",
                        "data": f"{ANO - 1}-01-15",
                        "atendimento_servicos": [{"nome_servico": "Sobrancelha", "preco_snapshot": 100.0}],
                        "atendimento_insumos": [],
                    },
                    {
                        "id": "atual-jan",
                        "data": f"{ANO}-01-15",
                        "atendimento_servicos": [{"nome_servico": "Sobrancelha", "preco_snapshot": 100.0}],
                        "atendimento_insumos": [],
                    },
                    {
                        "id": "atual-dez",
                        "data": f"{ANO}-12-15",
                        "atendimento_servicos": [{"nome_servico": "Extensão de cílios", "preco_snapshot": 200.0}],
                        "atendimento_insumos": [{"preco": 20.0}],
                    },
                ]
            },
            gastos_por_inicio={
                _iso(ANO - 1, 1): [
                    {"prazo": f"{ANO - 1}-01-05", "valor": 20.0},
                    {"prazo": f"{ANO}-01-05", "valor": 50.0},
                ]
            },
            custos_fixos=[{"valor": 100.0, "criado_em": "2020-01-01"}],
            meta_faturamento_mensal=9000.0,
        )

        resumo = await calcular_resumo_anual(sb, USER_ID, ANO)

        assert len(resumo.historico_doze_meses) == 12
        assert resumo.historico_doze_meses[0].receitas == 100.0
        assert resumo.historico_doze_meses[11].receitas == 200.0
        assert resumo.entrou == 300.0
        assert resumo.saiu == 1250.0
        assert resumo.saldo_final == -950.0
        assert resumo.comparacao.faturamento.anterior == 100.0
        assert resumo.comparacao.gastos.anterior == 1220.0
        assert resumo.comparacao.lucro.anterior == -1120.0
        assert resumo.comparacao.lucro.variacao_percentual == pytest.approx(15.18, abs=0.01)
