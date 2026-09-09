"""Schemas de `servicos` (endpoints-backend.md §8)."""

from pydantic import BaseModel, Field, field_validator, model_validator
from app.schemas.limites import LIMITE_VALOR_INPUT


class ProdutoPadraoIn(BaseModel):
    item_estoque_id: str
    # Para `rendimento_usos`, esta é a quantidade de usos por atendimento.
    quantidade: float = Field(allow_inf_nan=False)

    @model_validator(mode="after")
    def _validar(self):
        if self.quantidade <= 0:
            raise ValueError("quantidade deve ser maior que zero")
        return self


class ServicoIn(BaseModel):
    nome: str
    descricao: str = Field(default="", max_length=500)
    categoria: str = Field(default="Outros", max_length=60)
    preco: float = Field(le=LIMITE_VALOR_INPUT, allow_inf_nan=False)
    duracao_minutos: int
    produtos_padrao: list[ProdutoPadraoIn] = []

    @model_validator(mode="after")
    def _validar(self):
        if self.duracao_minutos <= 0:
            raise ValueError("duracao_minutos deve ser maior que zero")
        ids = [p.item_estoque_id for p in self.produtos_padrao]
        if len(ids) != len(set(ids)):
            raise ValueError("item_estoque_id repetido em produtos_padrao")
        return self

    @field_validator("categoria")
    @classmethod
    def _validar_categoria(cls, valor: str) -> str:
        categoria = valor.strip()
        if not categoria:
            raise ValueError("categoria não pode ficar vazia")
        return categoria


class ServicoPatchIn(BaseModel):
    nome: str | None = None
    descricao: str | None = Field(default=None, max_length=500)
    categoria: str | None = Field(default=None, max_length=60)
    preco: float | None = Field(default=None, le=LIMITE_VALOR_INPUT, allow_inf_nan=False)
    duracao_minutos: int | None = None
    produtos_padrao: list[ProdutoPadraoIn] | None = None

    @model_validator(mode="after")
    def _validar(self):
        if self.duracao_minutos is not None and self.duracao_minutos <= 0:
            raise ValueError("duracao_minutos deve ser maior que zero")
        if self.produtos_padrao is not None:
            ids = [p.item_estoque_id for p in self.produtos_padrao]
            if len(ids) != len(set(ids)):
                raise ValueError("item_estoque_id repetido em produtos_padrao")
        return self

    @field_validator("categoria")
    @classmethod
    def _validar_categoria(cls, valor: str | None) -> str | None:
        if valor is None:
            return None
        categoria = valor.strip()
        if not categoria:
            raise ValueError("categoria não pode ficar vazia")
        return categoria


class CategoriaServicoIn(BaseModel):
    nome: str = Field(min_length=1, max_length=60)

    @field_validator("nome")
    @classmethod
    def _validar_nome(cls, valor: str) -> str:
        nome = valor.strip()
        if not nome:
            raise ValueError("nome não pode ficar vazio")
        return nome


class CategoriaServicoOut(BaseModel):
    id: str
    nome: str


class CategoriasServicoListaOut(BaseModel):
    categorias: list[CategoriaServicoOut]


class ProdutoPadraoOut(BaseModel):
    item_estoque_id: str
    nome: str
    quantidade: float
    unidade: str
    modo_controle: str = "quantidade"
    usos_por_unidade: float | None = None
    custo_por_unidade_consumo: float | None = None
    unidade_consumo: str = "unidade"


class ServicoOut(BaseModel):
    id: str
    nome: str
    descricao: str = ""
    categoria: str
    preco: float
    duracao_minutos: int | None
    ativo: bool
    produtos_padrao: list[ProdutoPadraoOut]


class ServicosListaOut(BaseModel):
    servicos: list[ServicoOut]
