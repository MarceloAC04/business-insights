from pydantic import BaseModel, Field
from typing import Optional


# ── Entrada ────────────────────────────────────────────────────────

class FiltroRelatorio(BaseModel):
    """Parâmetros de query para /relatorio/mensal"""
    ano: int = Field(..., ge=2020, le=2100, description="Ano de referência")
    mes: int = Field(..., ge=1, le=12, description="Mês de referência (1–12)")


# ── Saída ──────────────────────────────────────────────────────────

class ServicoRanking(BaseModel):
    nome: str
    quantidade: int
    total_receita: float
    lucro: float = Field(
        default=0.0,
        description="total_receita rateado do custo de insumos do mês, proporcional à receita",
    )


class ResumoReceita(BaseModel):
    total_servicos: float = Field(description="Soma bruta dos serviços realizados")
    total_insumos: float = Field(description="Soma dos insumos descartáveis usados")
    liquido_atendimentos: float = Field(description="total_servicos - total_insumos")
    quantidade_atendimentos: int
    total_kits: float = Field(default=0.0, description="Receita de kits vendidos no mês")
    quantidade_kits_vendidos: int = Field(default=0)
    custo_kits_vendidos: float = Field(
        default=0.0,
        description="Informativo — já saiu quando o insumo do kit foi comprado, não entra em `saiu` de novo",
    )
    servicos_mais_realizados: list[ServicoRanking]


class ResumoGastos(BaseModel):
    total_custos_fixos: float = Field(description="Soma dos custos fixos cadastrados até o fim do mês")
    total_gastos_variaveis: float = Field(description="Soma dos gastos de categoria != fixo no mês")
    total_saiu: float = Field(description="total_custos_fixos + total_gastos_variaveis")


class PontoHistorico(BaseModel):
    ano: int
    mes: int
    receitas: float
    despesas: float


class ServicoMaisLucrativo(BaseModel):
    nome: str
    lucro: float


class ResumoInsights(BaseModel):
    ticket_medio: float = Field(description="total_servicos / quantidade_atendimentos (kit não entra)")
    margem_lucro_percentual: float = Field(description="(saldo_final / entrou) × 100")
    variacao_percentual_mes_anterior: float
    saldo_mes_anterior: float
    servico_mais_lucrativo: Optional[ServicoMaisLucrativo] = None


class ResumoMensal(BaseModel):
    ano: int
    mes: int
    saldo_final: float = Field(description="entrou - saiu")
    entrou: float = Field(description="total_servicos + total_kits")
    saiu: float = Field(description="total_custos_fixos + total_gastos_variaveis")
    meta_faturamento_mensal: float
    historico_seis_meses: list[PontoHistorico] = Field(
        description="Seis pontos cronológicos terminando no mês pedido, inclusive meses zerados"
    )
    receita: ResumoReceita
    gastos: ResumoGastos
    insights: ResumoInsights
    alerta_zero_a_zero: bool = Field(
        description="entrou > 0 e 0 <= saldo_final < limite_saldo_alerta da usuária"
    )


# ── Entrada ────────────────────────────────────────────────────────

class FiltroPrecificacao(BaseModel):
    """
    Dados necessários para calcular o preço mínimo de um serviço.
    O Flutter envia isso quando a usuária quer saber se está cobrindo os custos.
    """
    custo_material: float = Field(..., ge=0, description="Custo dos materiais usados no serviço (R$)")
    tempo_minutos: int = Field(..., ge=1, description="Duração do serviço em minutos")
    meta_hora: float = Field(
        ..., ge=0,
        description="Quanto a proprietária quer ganhar por hora de trabalho (R$)"
    )
    percentual_overhead: float = Field(
        default=0.15,
        ge=0,
        le=1,
        description="Fração dos custos fixos alocada neste serviço (padrão 15% — mesmo default do app, não enviado explicitamente pela tela)"
    )
    percentual_lucro: float = Field(
        default=0.20,
        ge=0,
        le=1,
        description="Margem de lucro desejada sobre o custo total (padrão 20%)"
    )


class ResultadoPrecificacao(BaseModel):
    custo_material: float
    custo_tempo: float = Field(description="meta_hora × (tempo_minutos / 60)")
    custo_overhead: float = Field(description="(custo_material + custo_tempo) × percentual_overhead")
    custo_total: float = Field(description="custo_material + custo_tempo + custo_overhead")
    preco_minimo: float = Field(description="custo_total × (1 + percentual_lucro)")
    preco_sugerido: float = Field(description="preco_minimo arredondado para o próximo R$5")
    cobrindo_custos: Optional[bool] = Field(
        default=None,
        description="Se um preço atual foi informado, indica se está acima do mínimo"
    )
    preco_atual: Optional[float] = None
    diferenca: Optional[float] = Field(
        default=None,
        description="preco_atual - preco_minimo (negativo = está no prejuízo)"
    )
