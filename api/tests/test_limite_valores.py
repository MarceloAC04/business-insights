"""Regressão do limite comum para valores monetários recebidos pela API."""

from datetime import date

import pytest
from pydantic import ValidationError

from app.schemas.alertas import PreferenciasAlertaUpdateIn
from app.schemas.atendimentos import MaterialEntradaIn, ServicoEntradaIn
from app.schemas.estoque import ItemIn, MovimentacaoIn
from app.schemas.gastos import GastoIn, GastoItem, GastoPatchIn
from app.schemas.kits import KitIn, KitPatchIn, VenderKitIn
from app.schemas.perfil import CustoFixoIn, CustoFixoPatchIn, PerfilUpdateIn
from app.schemas.relatorio import FiltroPrecificacao
from app.schemas.servicos import ServicoIn, ServicoPatchIn


LIMITE_EXCEDIDO = 1_000_000.01


@pytest.mark.parametrize(
    ("modelo", "dados"),
    [
        (GastoItem, {"nome": "Material", "preco": LIMITE_EXCEDIDO}),
        (
            GastoIn,
            {
                "nome": "Conta",
                "valor": LIMITE_EXCEDIDO,
                "prazo_pagamento": date(2026, 9, 9),
            },
        ),
        (GastoPatchIn, {"valor": LIMITE_EXCEDIDO}),
        (PerfilUpdateIn, {"nome": "Salão", "meta_faturamento_mensal": LIMITE_EXCEDIDO}),
        (CustoFixoIn, {"descricao": "Aluguel", "valor": LIMITE_EXCEDIDO, "dia_vencimento": 5}),
        (CustoFixoPatchIn, {"valor": LIMITE_EXCEDIDO}),
        (ServicoEntradaIn, {"nome": "Serviço avulso", "preco": LIMITE_EXCEDIDO}),
        (
            MaterialEntradaIn,
            {"item_estoque_id": "item", "quantidade": 1, "preco": LIMITE_EXCEDIDO},
        ),
        (ServicoIn, {"nome": "Serviço", "preco": LIMITE_EXCEDIDO, "duracao_minutos": 60}),
        (ServicoPatchIn, {"preco": LIMITE_EXCEDIDO}),
        (KitIn, {"nome": "Kit", "preco_venda": LIMITE_EXCEDIDO}),
        (KitPatchIn, {"preco_venda": LIMITE_EXCEDIDO}),
        (VenderKitIn, {"quantidade": 1, "preco_unitario": LIMITE_EXCEDIDO}),
        (
            FiltroPrecificacao,
            {"custo_material": LIMITE_EXCEDIDO, "tempo_minutos": 60, "meta_hora": 100},
        ),
        (
            FiltroPrecificacao,
            {"custo_material": 100, "tempo_minutos": 60, "meta_hora": LIMITE_EXCEDIDO},
        ),
        (PreferenciasAlertaUpdateIn, {"limite_saldo_alerta": LIMITE_EXCEDIDO}),
        (
            ItemIn,
            {
                "nome": "Cola",
                "unidade": "un",
                "categoria": "cilios",
                "custo_unitario": LIMITE_EXCEDIDO,
            },
        ),
        (
            MovimentacaoIn,
            {"tipo": "entrada", "quantidade": 1, "custo_unitario": LIMITE_EXCEDIDO},
        ),
    ],
)
def test_valor_acima_de_um_milhao_e_rejeitado(modelo, dados):
    with pytest.raises(ValidationError):
        modelo(**dados)
