"""Schemas de `estoque` (endpoints-backend.md §5)."""

from pydantic import BaseModel, model_validator

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
# Além de saldo em unidades (padrão), um item pode ser controlado pelo tempo
# desde que a unidade em uso foi aberta (`validade_dias`) ou pela quantidade
# de atendimentos que ela já rendeu (`validade_atendimentos`) — pedido do
# dono do projeto (06/09/2026, 008_estoque_validade_e_catalogo.sql).
MODOS_CONTROLE = {"quantidade", "validade_dias", "validade_atendimentos"}


class ItemIn(BaseModel):
    nome: str
    unidade: str
    categoria: str
    quantidade_atual: float = 0
    quantidade_minima: float = 0
    custo_unitario: float = 0
    codigo_barras: str | None = None
    modo_controle: str = "quantidade"
    duracao_dias: int | None = None
    duracao_atendimentos: int | None = None

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
        _validar_modo_controle(self.modo_controle, self.duracao_dias, self.duracao_atendimentos)
        return self


class ItemPatchIn(BaseModel):
    nome: str | None = None
    unidade: str | None = None
    categoria: str | None = None
    quantidade_minima: float | None = None
    codigo_barras: str | None = None
    modo_controle: str | None = None
    duracao_dias: int | None = None
    duracao_atendimentos: int | None = None

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
            _validar_modo_controle(self.modo_controle, self.duracao_dias, self.duracao_atendimentos)
        return self


def _validar_modo_controle(modo: str, duracao_dias: int | None, duracao_atendimentos: int | None) -> None:
    if modo not in MODOS_CONTROLE:
        raise ValueError(f"modo_controle deve ser um de {MODOS_CONTROLE}")
    if modo == "validade_dias" and not duracao_dias:
        raise ValueError("duracao_dias é obrigatório quando modo_controle é validade_dias")
    if modo == "validade_atendimentos" and not duracao_atendimentos:
        raise ValueError(
            "duracao_atendimentos é obrigatório quando modo_controle é validade_atendimentos"
        )


class MovimentacaoIn(BaseModel):
    tipo: str
    quantidade: float
    motivo: str = ""
    custo_unitario: float | None = None

    @model_validator(mode="after")
    def _validar(self):
        if self.tipo not in TIPOS_MOVIMENTACAO:
            raise ValueError(f"tipo deve ser um de {TIPOS_MOVIMENTACAO}")
        if self.quantidade <= 0:
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
    duracao_dias: int | None = None
    duracao_atendimentos: int | None = None
    unidade_aberta_em: str | None = None
    atendimentos_desde_abertura: int = 0
    # Calculados no backend (não dá pra gerar no Postgres — depende de
    # `now()`). Ausentes (`None`) quando modo_controle é "quantidade".
    dias_restantes: int | None = None
    atendimentos_restantes: int | None = None
    status_validade: str | None = None


class EstoquePaginaOut(BaseModel):
    total_alertas: int
    valor_total: float
    itens: list[ItemOut]


class MovimentacaoOut(BaseModel):
    id: str
    item_id: str
    item_nome: str
    tipo: str
    quantidade: float
    motivo: str
    atendimento_id: str | None
    criado_em: str


class MovimentacoesListaOut(BaseModel):
    movimentacoes: list[MovimentacaoOut]
