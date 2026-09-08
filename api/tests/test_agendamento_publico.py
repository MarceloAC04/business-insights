"""
Testes unitários e de integração para o módulo /agendamento-publico
(endpoints-backend.md §10).

As 3 operações delegam para RPCs `security definer` — os testes mockam
`supabase.rpc(...).execute()` devolvendo o jsonb já no formato que a função
Postgres devolveria, e simulam `postgrest.exceptions.APIError` para os 3
códigos que a RPC pode levantar (`SALAO_NAO_ENCONTRADO`, `SERVICO_INVALIDO`/
`VALIDACAO_INVALIDA`, `HORARIO_INDISPONIVEL`).
"""

import uuid
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.main import app
from app.core.supabase_client import get_supabase_publico
from app.services import agendamento_publico_service as service


TEST_SLUG = "thamires-beauty"
TEST_SERVICO_ID = str(uuid.uuid4())
TEST_ATENDIMENTO_ID = str(uuid.uuid4())


@pytest.fixture
def client():
    return TestClient(app)


def _api_error(mensagem: str) -> APIError:
    return APIError({"message": mensagem, "code": "P0001", "hint": None, "details": None})


def _mock_rpc(mock_sb: MagicMock, retorno=None, erro: APIError | None = None):
    mock_rpc = MagicMock()
    if erro is not None:
        mock_rpc.execute.side_effect = erro
    else:
        mock_rpc.execute.return_value = MagicMock(data=retorno)
    mock_sb.rpc.return_value = mock_rpc
    return mock_rpc


class TestAgendamentoPublicoServiceRpc:
    def test_obter_pagina_chama_rpc_com_slug(self):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, retorno={
            "salao": {"nome": "Thamires Beauty", "foto_url": None},
            "servicos": [{"id": TEST_SERVICO_ID, "nome": "Extensão", "preco": 180.0, "duracao_minutos": 90}],
        })

        resultado = service.obter_pagina(mock_sb, TEST_SLUG)

        mock_sb.rpc.assert_called_once_with("agendamento_publico_pagina", {"p_slug": TEST_SLUG})
        assert resultado["salao"]["nome"] == "Thamires Beauty"
        assert resultado["servicos"][0]["id"] == TEST_SERVICO_ID

    def test_obter_pagina_traduz_salao_nao_encontrado(self):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, erro=_api_error("SALAO_NAO_ENCONTRADO"))

        with pytest.raises(Exception) as exc_info:
            service.obter_pagina(mock_sb, "slug-invalido")

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail["codigo"] == "RECURSO_NAO_ENCONTRADO"

    def test_calcular_horarios_chama_rpc_com_params(self):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, retorno={"duracao_total_minutos": 90, "horarios": ["09:00", "09:30"]})

        resultado = service.calcular_horarios_disponiveis(mock_sb, TEST_SLUG, "2026-09-10", [TEST_SERVICO_ID])

        mock_sb.rpc.assert_called_once_with(
            "agendamento_publico_horarios",
            {"p_slug": TEST_SLUG, "p_data": "2026-09-10", "p_servico_ids": [TEST_SERVICO_ID]},
        )
        assert resultado["horarios"] == ["09:00", "09:30"]

    def test_calcular_horarios_traduz_servico_invalido(self):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, erro=_api_error("SERVICO_INVALIDO"))

        with pytest.raises(Exception) as exc_info:
            service.calcular_horarios_disponiveis(mock_sb, TEST_SLUG, "2026-09-10", ["id-invalido"])

        assert exc_info.value.status_code == 422
        assert exc_info.value.detail["codigo"] == "VALIDACAO_INVALIDA"

    def test_criar_agendamento_chama_rpc_com_params(self):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, retorno={
            "id": TEST_ATENDIMENTO_ID,
            "data": "2026-09-10T12:00:00-03:00",
            "status": "agendado",
            "servicos": [{"servico_id": TEST_SERVICO_ID, "nome": "Extensão", "preco": 180.0}],
        })
        from datetime import datetime, timezone
        data_hora = datetime(2026, 9, 10, 15, 0, tzinfo=timezone.utc)

        resultado = service.criar_agendamento(
            mock_sb, TEST_SLUG, "Cliente Teste", "551199990000", data_hora, [TEST_SERVICO_ID]
        )

        mock_sb.rpc.assert_called_once_with(
            "agendamento_publico_agendar",
            {
                "p_slug": TEST_SLUG,
                "p_cliente_nome": "Cliente Teste",
                "p_cliente_telefone": "551199990000",
                "p_data": data_hora.isoformat(),
                "p_servico_ids": [TEST_SERVICO_ID],
            },
        )
        assert resultado["id"] == TEST_ATENDIMENTO_ID

    def test_criar_agendamento_traduz_horario_indisponivel(self):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, erro=_api_error("HORARIO_INDISPONIVEL"))
        from datetime import datetime, timezone

        with pytest.raises(Exception) as exc_info:
            service.criar_agendamento(
                mock_sb, TEST_SLUG, "Cliente", "551199990000",
                datetime(2026, 9, 10, 15, 0, tzinfo=timezone.utc), [TEST_SERVICO_ID],
            )

        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["codigo"] == "HORARIO_INDISPONIVEL"


class TestAgendamentoPublicoEndpoints:
    def test_obter_pagina_endpoint(self, client):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, retorno={
            "salao": {"nome": "Thamires Beauty", "foto_url": None},
            "servicos": [{"id": TEST_SERVICO_ID, "nome": "Extensão", "preco": 180.0, "duracao_minutos": 90}],
        })
        app.dependency_overrides[get_supabase_publico] = lambda: mock_sb
        try:
            response = client.get(f"/v1/agendamento-publico/{TEST_SLUG}")
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["salao"]["nome"] == "Thamires Beauty"
        finally:
            app.dependency_overrides.clear()

    def test_obter_pagina_endpoint_slug_invalido_retorna_404(self, client):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, erro=_api_error("SALAO_NAO_ENCONTRADO"))
        app.dependency_overrides[get_supabase_publico] = lambda: mock_sb
        try:
            response = client.get("/v1/agendamento-publico/slug-invalido")
            assert response.status_code == 404
            assert response.json()["codigo"] == "RECURSO_NAO_ENCONTRADO"
        finally:
            app.dependency_overrides.clear()

    def test_agendar_endpoint(self, client):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, retorno={
            "id": TEST_ATENDIMENTO_ID,
            "data": "2026-09-10T12:00:00-03:00",
            "status": "agendado",
            "servicos": [{"servico_id": TEST_SERVICO_ID, "nome": "Extensão", "preco": 180.0}],
        })
        app.dependency_overrides[get_supabase_publico] = lambda: mock_sb
        try:
            response = client.post(
                f"/v1/agendamento-publico/{TEST_SLUG}/agendar",
                json={
                    "cliente_nome": "Cliente Teste",
                    "cliente_telefone": "551199990000",
                    "data": "2026-09-10T15:00:00Z",
                    "servicos": [{"servico_id": TEST_SERVICO_ID}],
                },
            )
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["id"] == TEST_ATENDIMENTO_ID
        finally:
            app.dependency_overrides.clear()

    def test_agendar_endpoint_horario_indisponivel_retorna_409(self, client):
        mock_sb = MagicMock()
        _mock_rpc(mock_sb, erro=_api_error("HORARIO_INDISPONIVEL"))
        app.dependency_overrides[get_supabase_publico] = lambda: mock_sb
        try:
            response = client.post(
                f"/v1/agendamento-publico/{TEST_SLUG}/agendar",
                json={
                    "cliente_nome": "Cliente Teste",
                    "cliente_telefone": "551199990000",
                    "data": "2026-09-10T15:00:00Z",
                    "servicos": [{"servico_id": TEST_SERVICO_ID}],
                },
            )
            assert response.status_code == 409
            assert response.json()["codigo"] == "HORARIO_INDISPONIVEL"
        finally:
            app.dependency_overrides.clear()
