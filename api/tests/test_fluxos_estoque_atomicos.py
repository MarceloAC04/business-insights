"""Contrato HTTP das RPCs atômicas da etapa 4.

As transações, rollback e conversões são executados contra PostgreSQL em
`database/tests/fluxos_estoque_atomicos.test.mjs`. Aqui validamos que o FastAPI
envia o corpo correto e mantém os códigos HTTP públicos do contrato.
"""

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.atendimentos import FinalizarBodyIn, MaterialEntradaIn
from app.schemas.kits import MontarKitIn, VenderKitIn
from app.services import atendimentos_service, kits_service


USER_ID = "11111111-1111-4111-8111-111111111111"
ATENDIMENTO_ID = "22222222-2222-4222-8222-222222222222"
ITEM_ID = "33333333-3333-4333-8333-333333333333"
KIT_ID = "44444444-4444-4444-8444-444444444444"


def _supabase(resultado: dict) -> MagicMock:
    sb = MagicMock()
    sb.rpc.return_value.execute.return_value = MagicMock(data=resultado)
    return sb


def test_finalizar_mantem_duas_passadas_no_contrato():
    sb = _supabase({
        "codigo": "ESTOQUE_INSUFICIENTE",
        "faltantes": [{"item_estoque_id": ITEM_ID, "quantidade_disponivel": 0}],
    })

    with pytest.raises(HTTPException) as exc:
        atendimentos_service.finalizar(
            sb, USER_ID, ATENDIMENTO_ID,
            FinalizarBodyIn(materiais=[MaterialEntradaIn(item_estoque_id=ITEM_ID, quantidade=2)]),
        )

    assert exc.value.status_code == 409
    assert exc.value.detail["codigo"] == "ESTOQUE_INSUFICIENTE"
    sb.rpc.assert_called_once_with("finalizar_atendimento_estoque", {
        "p_atendimento_id": ATENDIMENTO_ID,
        "p_user_id": USER_ID,
        "p_materiais": [{"item_estoque_id": ITEM_ID, "quantidade": 2.0}],
        "p_confirmar_estoque_insuficiente": False,
    })


def test_finalizar_sucesso_consulta_resultado_apos_transacao(monkeypatch):
    sb = _supabase({"codigo": "OK"})
    monkeypatch.setattr(atendimentos_service, "obter", lambda *_: {"id": ATENDIMENTO_ID, "status": "finalizado"})

    resultado = atendimentos_service.finalizar(
        sb, USER_ID, ATENDIMENTO_ID,
        FinalizarBodyIn(materiais=[], confirmar_estoque_insuficiente=True),
    )

    assert resultado == {"id": ATENDIMENTO_ID, "status": "finalizado"}
    assert sb.rpc.call_args.args[0] == "finalizar_atendimento_estoque"


def test_cancelar_status_invalido_nao_tenta_estorno_cliente():
    sb = _supabase({"codigo": "ATENDIMENTO_STATUS_INVALIDO"})

    with pytest.raises(HTTPException) as exc:
        atendimentos_service.cancelar(sb, USER_ID, ATENDIMENTO_ID)

    assert exc.value.status_code == 409
    assert exc.value.detail["codigo"] == "ATENDIMENTO_STATUS_INVALIDO"
    sb.rpc.assert_called_once_with("cancelar_atendimento_estoque", {
        "p_atendimento_id": ATENDIMENTO_ID,
        "p_user_id": USER_ID,
    })


def test_montar_kit_preserva_erro_de_saldo():
    sb = _supabase({"codigo": "ESTOQUE_INSUFICIENTE", "faltantes": [{"item_estoque_id": ITEM_ID}]})

    with pytest.raises(HTTPException) as exc:
        kits_service.montar(sb, USER_ID, KIT_ID, MontarKitIn(quantidade=2))

    assert exc.value.status_code == 409
    assert exc.value.detail["codigo"] == "ESTOQUE_INSUFICIENTE"
    assert sb.rpc.call_args.args[0] == "montar_kit_estoque"


def test_vender_kit_preserva_erro_de_saldo_montado():
    sb = _supabase({"codigo": "KIT_NAO_MONTADO", "quantidade_montada": 1, "quantidade_solicitada": 2})

    with pytest.raises(HTTPException) as exc:
        kits_service.vender(sb, USER_ID, KIT_ID, VenderKitIn(quantidade=2, forma_pagamento="pix"))

    assert exc.value.status_code == 409
    assert exc.value.detail["codigo"] == "KIT_NAO_MONTADO"
    assert exc.value.detail["result"]["quantidade_montada"] == 1
    assert sb.rpc.call_args.args[0] == "vender_kit_estoque"


def test_vender_kit_sucesso_retorna_estado_atualizado(monkeypatch):
    sb = _supabase({"codigo": "OK"})
    monkeypatch.setattr(kits_service, "obter", lambda *_: {"id": KIT_ID, "quantidade_montada": 1})

    resultado = kits_service.vender(sb, USER_ID, KIT_ID, VenderKitIn(quantidade=1, forma_pagamento="pix"))

    assert resultado["quantidade_montada"] == 1
    chamada = sb.rpc.call_args
    assert chamada.args[0] == "vender_kit_estoque"
    assert chamada.args[1]["p_preco_unitario"] is None
    assert chamada.args[1]["p_data"] is None


def test_kit_nao_aceita_fracao_de_unidade():
    with pytest.raises(ValidationError):
        MontarKitIn(quantidade=0.5)
    with pytest.raises(ValidationError):
        VenderKitIn(quantidade=1.5)
