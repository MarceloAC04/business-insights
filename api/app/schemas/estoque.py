"""Schemas de `estoque` (endpoints-backend.md §5)."""

from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.schemas.limites import LIMITE_VALOR_INPUT

UNIDADES = {"un", "ml", "g", "cx"}
CATEGORIAS = {
    "cilios",
    "sobrancelha",
    "limpeza_pele",
    "descartavel",
    "micropigmentacao",
    "reconstrucao",
    "outro",
}
TIPOS_MOVIMENTACAO = {"entrada", "saida", "ajuste"}
# `rendimento_usos` é o modelo para potes/frascos: o saldo continua sendo de
# embalagens físicas, e cada baixa de serviço informa quantos usos consumiu.
MODOS_CONTROLE = {"quantidade", "rendimento_usos"}


class ItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nome: str
    unidade: str
    categoria: str
    quantidade_atual: float = 0
    quantidade_minima: float = 0
    custo_unitario: float = Field(
        default=0, ge=0, le=LIMITE_VALOR_INPUT, allow_inf_nan=False
    )
    codigo_barras: str | None = None
    modo_controle: str = "quantidade"
    usos_por_unidade: float | None = Field(default=None, allow_inf_nan=False)
    usos_minimos: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _validar(self):
        if self.unidade not in UNIDADES:
            raise ValueError(f"unidade deve ser uma de {UNIDADES}")
        if self.categoria not in CATEGORIAS:
            raise ValueError(f"categoria deve ser uma de {CATEGORIAS}")
        if self.quantidade_minima < 0:
            raise ValueError("quantidade_minima não pode ser negativa")
        if self.codigo_barras is not None:
            self.codigo_barras = self.codigo_barras.strip() or None
        _validar_modo_controle(
            self.modo_controle,
            self.unidade,
            self.usos_por_unidade,
        )
        return self


class ItemPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nome: str | None = None
    unidade: str | None = None
    categoria: str | None = None
    quantidade_minima: float | None = None
    codigo_barras: str | None = None
    modo_controle: str | None = None
    usos_por_unidade: float | None = Field(default=None, allow_inf_nan=False)
    usos_minimos: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    confirmar_unidade_fisica: bool = False

    @model_validator(mode="after")
    def _validar(self):
        if self.unidade is not None and self.unidade not in UNIDADES:
            raise ValueError(f"unidade deve ser uma de {UNIDADES}")
        if self.categoria is not None and self.categoria not in CATEGORIAS:
            raise ValueError(f"categoria deve ser uma de {CATEGORIAS}")
        if self.quantidade_minima is not None and self.quantidade_minima < 0:
            raise ValueError("quantidade_minima não pode ser negativa")
        if self.codigo_barras is not None:
            self.codigo_barras = self.codigo_barras.strip() or None
        if self.modo_controle is not None:
            _validar_modo_controle(
                self.modo_controle,
                self.unidade,
                self.usos_por_unidade,
            )
        return self


def _validar_modo_controle(
    modo: str,
    unidade: str | None,
    usos_por_unidade: float | None,
) -> None:
    if modo not in MODOS_CONTROLE:
        raise ValueError(f"modo_controle deve ser um de {MODOS_CONTROLE}")
    if modo == "rendimento_usos":
        if unidade is not None and unidade != "un":
            raise ValueError("rendimento_usos usa unidade 'un' para potes, frascos ou embalagens")
        if usos_por_unidade is None or usos_por_unidade <= 0:
            raise ValueError("usos_por_unidade deve ser maior que zero em rendimento_usos")


class MovimentacaoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tipo: str
    quantidade: float = Field(allow_inf_nan=False)
    motivo: str = ""
    custo_unitario: float | None = Field(
        default=None, ge=0, le=LIMITE_VALOR_INPUT, allow_inf_nan=False
    )

    @model_validator(mode="after")
    def _validar(self):
        if self.tipo not in TIPOS_MOVIMENTACAO:
            raise ValueError(f"tipo deve ser um de {TIPOS_MOVIMENTACAO}")
        if self.tipo == "ajuste" and self.quantidade < 0:
            raise ValueError("A quantidade contada não pode ser negativa")
        if self.tipo != "ajuste" and self.quantidade <= 0:
            raise ValueError("quantidade deve ser maior que zero")
        return self


class ItemOut(BaseModel):
    id: str
    nome: str
    unidade: str
    categoria: str
    quantidade_atual: float
    quantidade_minima: float
    custo_medio: float
    custo_ultima_compra: float
    status: str
    deficit: float
    ativo: bool
    codigo_barras: str | None = None
    modo_controle: str = "quantidade"
    usos_por_unidade: float | None = None
    usos_minimos: float | None = None
    # Derivados de `quantidade_atual × usos_por_unidade`; são a capacidade
    # que a tela mostra e que serviços consomem no modo rendimento.
    usos_disponiveis: float | None = None
    custo_por_uso: float | None = None
    deficit_usos: float | None = None
    status_rendimento: str | None = None


class PlanejamentoReposicaoOut(BaseModel):
    """Sugestão explicável, sempre somente de leitura, para a próxima compra."""

    item_id: str
    nome: str
    unidade_consumo: str
    quantidade_atual: float
    quantidade_minima: float
    consumo_medio_diario: float
    consumo_agendado: float
    atendimentos_agendados: int
    quantidade_sugerida: float
    embalagens_sugeridas: int | None = None
    base_calculo: str


class EstoquePaginaOut(BaseModel):
    total_alertas: int
    valor_total: float
    itens: list[ItemOut]
    planejamento_reposicao: list[PlanejamentoReposicaoOut] = []


class MovimentacaoOut(BaseModel):
    id: str
    item_id: str
    item_nome: str
    tipo: str
    quantidade: float
    motivo: str
    atendimento_id: str | None
    criado_em: str
    saldo_anterior: float | None = None
    saldo_atual: float | None = None
    # No modo rendimento, `quantidade` continua sendo a fração física do
    # pote; estes campos preservam no histórico o que a usuária informou.
    quantidade_consumida: float | None = None
    unidade_consumo: str | None = None


class MovimentacoesListaOut(BaseModel):
    movimentacoes: list[MovimentacaoOut]
