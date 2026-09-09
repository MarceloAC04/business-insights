"""Schemas de `kits` (endpoints-backend.md §6)."""

from datetime import datetime
from pydantic import BaseModel, Field

from app.schemas.gastos import FormaPagamento
from app.schemas.limites import LIMITE_VALOR_INPUT


class KitItemIn(BaseModel):
    item_estoque_id: str
    quantidade: float = Field(gt=0)


class KitIn(BaseModel):
    nome: str = Field(min_length=1)
    preco_venda: float = Field(gt=0, le=LIMITE_VALOR_INPUT, allow_inf_nan=False)
    itens: list[KitItemIn] = Field(default_factory=list)


class KitPatchIn(BaseModel):
    nome: str | None = Field(default=None, min_length=1)
    preco_venda: float | None = Field(
        default=None, gt=0, le=LIMITE_VALOR_INPUT, allow_inf_nan=False
    )
    itens: list[KitItemIn] | None = None


class MontarKitIn(BaseModel):
    # Kit é uma unidade de revenda inteira; aceitar 0,5 aqui entraria em
    # conflito com `kits.quantidade_montada`, que é inteira no banco.
    quantidade: int = Field(gt=0)
    confirmar_estoque_insuficiente: bool = False


class VenderKitIn(BaseModel):
    quantidade: int = Field(gt=0)
    forma_pagamento: FormaPagamento = "a_vista"
    preco_unitario: float | None = Field(
        default=None, le=LIMITE_VALOR_INPUT, allow_inf_nan=False
    )
    data: datetime | None = None


class KitItemOut(BaseModel):
    item_estoque_id: str
    nome: str
    quantidade: float
    unidade: str


class KitOut(BaseModel):
    id: str
    nome: str
    preco_venda: float
    custo_total: float
    margem: float
    quantidade_montada: float
    quantidade_montavel: float
    disponivel: bool
    itens: list[KitItemOut] = Field(default_factory=list)


class KitsListaOut(BaseModel):
    kits: list[KitOut]
