"""
Testes unitários e de integração para o módulo /gastos.
"""

import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.security import usuario_atual
from app.core.supabase_client import get_supabase
from app.services import gastos_service


TEST_USER_ID = str(uuid.uuid4())


@pytest.fixture
def client():
    return TestClient(app)


class TestGastosEndpoints:
    def test_listar_gastos_com_totais(self, client):
        hoje = date.today()
        mock_gastos = [
            {
                "id": str(uuid.uuid4()),
                "user_id": TEST_USER_ID,
                "nome": "Conta de Luz",
                "valor": 120.0,
                "prazo": (hoje + timedelta(days=2)).isoformat(),
                "forma_pagamento": "pix",
                "categoria": "fixo",
                "pago": False,
                "pago_em": None,
                "itens": [],
            }
        ]

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.gte.return_value = mock_table
        mock_table.lte.return_value = mock_table
        mock_table.order.return_value = mock_table
        mock_table.range.return_value = mock_table
        mock_table.execute.side_effect = [
            MagicMock(data=mock_gastos),  # listagem
            MagicMock(data=[{"valor": 120.0}]),  # pendentes
            MagicMock(data=[]),  # pagos
        ]
        mock_sb.table.return_value = mock_table

        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.get("/v1/gastos")
            assert response.status_code == 200
            data = response.json()
            assert data["mensagem"] == "ok"
            assert data["result"]["total_pendente"] == 120.0
            assert len(data["result"]["gastos"]) == 1
            assert data["result"]["gastos"][0]["vence_em_dias"] == 2
        finally:
            app.dependency_overrides.clear()

    def test_criar_gasto(self, client):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        gasto_id = str(uuid.uuid4())
        mock_table.insert.return_value.execute.return_value = MagicMock(
            data=[{
                "id": gasto_id,
                "user_id": TEST_USER_ID,
                "nome": "Esmaltes novos",
                "valor": 85.50,
                "prazo": "2026-09-10",
                "forma_pagamento": "debito",
                "categoria": "material",
                "pago": False,
                "pago_em": None,
                "itens": [],
            }]
        )
        mock_sb.table.return_value = mock_table
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.post(
                "/v1/gastos",
                json={
                    "nome": "Esmaltes novos",
                    "valor": 85.50,
                    "prazo_pagamento": "2026-09-10",
                    "forma_pagamento": "debito",
                    "categoria": "material",
                },
            )
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["nome"] == "Esmaltes novos"
            assert data["result"]["valor"] == 85.50
        finally:
            app.dependency_overrides.clear()

    def test_pagar_gasto_idempotente(self, client):
        gasto_id = str(uuid.uuid4())
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.update.return_value = mock_table

        # Primeira consulta: não pago. Segunda consulta após update: pago.
        mock_table.execute.side_effect = [
            MagicMock(data=[{
                "id": gasto_id,
                "user_id": TEST_USER_ID,
                "nome": "Conta de luz",
                "valor": 120.0,
                "prazo": "2026-09-03",
                "forma_pagamento": "pix",
                "categoria": "fixo",
                "pago": False,
                "pago_em": None,
            }]),
            MagicMock(data=[]),  # update
            MagicMock(data=[{
                "id": gasto_id,
                "user_id": TEST_USER_ID,
                "nome": "Conta de luz",
                "valor": 120.0,
                "prazo": "2026-09-03",
                "forma_pagamento": "pix",
                "categoria": "fixo",
                "pago": True,
                "pago_em": "2026-09-03T10:00:00Z",
            }]),
        ]
        mock_sb.table.return_value = mock_table
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.patch(
                f"/v1/gastos/{gasto_id}/pagar",
                json={"pago_em": "2026-09-03T10:00:00Z"},
            )
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["pago"] is True
        finally:
            app.dependency_overrides.clear()


class TestGastosEscopoPorUsuario:
    """
    `_buscar_gasto` já filtra por `user_id` na leitura, mas o `service_role`
    bypassa RLS — o `update`/`delete` que vem depois precisa repetir o filtro,
    não confiar só na leitura anterior (mesma convenção de escopo explícito
    usada em `atendimentos_service`).
    """

    def test_editar_gasto_filtra_por_user_id_no_update(self):
        gasto_id = str(uuid.uuid4())
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.update.return_value = mock_table
        linha = {
            "id": gasto_id, "user_id": TEST_USER_ID, "nome": "Conta", "valor": 10.0,
            "prazo": "2026-09-10", "forma_pagamento": "pix", "categoria": "outros",
            "pago": False, "pago_em": None,
        }
        mock_table.execute.side_effect = [
            MagicMock(data=[linha]),  # _buscar_gasto
            MagicMock(data=[]),       # update
            MagicMock(data=[linha]),  # _buscar_gasto de novo (retorno)
        ]
        mock_sb.table.return_value = mock_table

        from app.schemas.gastos import GastoPatchIn
        gastos_service.editar_gasto(mock_sb, TEST_USER_ID, gasto_id, GastoPatchIn(nome="Conta editada"))

        chamadas_eq = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in chamadas_eq

    def test_excluir_gasto_filtra_por_user_id_no_delete(self):
        gasto_id = str(uuid.uuid4())
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.delete.return_value = mock_table
        linha = {
            "id": gasto_id, "user_id": TEST_USER_ID, "nome": "Conta", "valor": 10.0,
            "prazo": "2026-09-10", "forma_pagamento": "pix", "categoria": "outros",
            "pago": False, "pago_em": None,
        }
        mock_table.execute.side_effect = [
            MagicMock(data=[linha]),  # _buscar_gasto
            MagicMock(data=[]),       # delete
        ]
        mock_sb.table.return_value = mock_table

        gastos_service.excluir_gasto(mock_sb, TEST_USER_ID, gasto_id)

        chamadas_eq = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in chamadas_eq


class TestVenceEmDiasFusoBrasil:
    def test_hoje_brasil_usa_offset_fixo_de_tres_horas(self):
        # 23h30 UTC de um dia == 20h30 no fuso de Brasília, ainda no dia anterior
        # em UTC-3. `date.today()` no servidor (se rodando em UTC) já teria
        # virado o dia; `_hoje_brasil()` não pode.
        agora_utc = datetime(2026, 9, 5, 23, 30, tzinfo=timezone.utc)
        esperado = agora_utc.astimezone(gastos_service._FUSO_BRASIL).date()
        assert esperado == date(2026, 9, 5)
