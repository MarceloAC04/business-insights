"""
Testes unitários e de integração para o módulo /perfil e /perfil/custos-fixos.
"""

import uuid
from io import BytesIO
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.security import usuario_atual
from app.core.supabase_client import get_supabase
from app.schemas.perfil import CustoFixoPatchIn, HorarioDia, PerfilUpdateIn
from app.services import perfil_service


TEST_USER_ID = str(uuid.uuid4())
TEST_CUSTO_ID = str(uuid.uuid4())


@pytest.fixture
def client():
    return TestClient(app)


class TestPerfilEndpoints:
    def test_obter_perfil(self, client):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.single.return_value = mock_table
        mock_table.execute.return_value = MagicMock(
            data={
                "id": str(uuid.uuid4()),
                "user_id": TEST_USER_ID,
                "nome_salao": "Thamires Borges Beauty",
                "nome_proprietaria": "Thamires Borges",
                "foto_url": None,
                "telefone": "5511999990000",
                "instagram_url": "@thamiresbeauty",
                "endereco": "São Paulo, SP",
                "descricao_publica": "Especialista em cílios",
                "meta_faturamento_mensal": 9000.0,
            }
        )
        mock_sb.table.return_value = mock_table
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.get("/v1/perfil")
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["salao"]["nome"] == "Thamires Borges Beauty"
            assert data["result"]["salao"]["instagram_url"] == "@thamiresbeauty"
            assert data["result"]["salao"]["meta_faturamento_mensal"] == 9000.0
        finally:
            app.dependency_overrides.clear()

    def test_listar_custos_fixos_com_pagamento_por_competencia(self, client):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.order.return_value = mock_table

        # 1. custos_fixos
        # 2. custos_fixos_pagamentos
        mock_table.execute.side_effect = [
            MagicMock(data=[{
                "id": TEST_CUSTO_ID,
                "descricao": "Aluguel",
                "valor": 1200.0,
                "dia_vencimento": 5,
            }]),
            MagicMock(data=[{
                "custo_fixo_id": TEST_CUSTO_ID,
                "pago_em": "2026-09-03T10:00:00Z",
            }]),
        ]
        mock_sb.table.return_value = mock_table
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.get("/v1/perfil/custos-fixos?competencia=2026-09")
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["total_mensal"] == 1200.0
            assert data["result"]["total_pago"] == 1200.0
            assert data["result"]["total_pendente"] == 0.0
            assert len(data["result"]["custos"]) == 1
            assert data["result"]["custos"][0]["pago"] is True
            assert data["result"]["custos"][0]["competencia"] == "2026-09"
        finally:
            app.dependency_overrides.clear()

    def test_enviar_foto_png_valida_e_devolve_url_publica(self, client):
        mock_sb = MagicMock()
        bucket = MagicMock()
        bucket.get_public_url.return_value = "https://cdn.exemplo/foto"
        mock_sb.storage.from_.return_value = bucket
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            png = b"\x89PNG\r\n\x1a\n" + b"imagem"
            response = client.post(
                "/v1/perfil/foto",
                files={"arquivo": ("logo.png", BytesIO(png), "image/png")},
            )
            assert response.status_code == 200
            assert response.json()["result"]["foto_url"] == "https://cdn.exemplo/foto"
            bucket.upload.assert_called_once()
            assert bucket.upload.call_args.args[0] == f"saloes/{TEST_USER_ID}/perfil"
        finally:
            app.dependency_overrides.clear()

    def test_enviar_foto_rejeita_tipo_que_nao_e_imagem(self, client):
        mock_sb = MagicMock()
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.post(
                "/v1/perfil/foto",
                files={"arquivo": ("texto.txt", BytesIO(b"nao sou uma imagem"), "text/plain")},
            )
            assert response.status_code == 422
            mock_sb.storage.from_.assert_not_called()
        finally:
            app.dependency_overrides.clear()

    def test_pagar_custo_fixo_competencia(self, client):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.upsert.return_value = mock_table

        mock_table.execute.side_effect = [
            MagicMock(data=[{
                "id": TEST_CUSTO_ID,
                "descricao": "Aluguel",
                "valor": 1200.0,
                "dia_vencimento": 5,
            }]),
            MagicMock(data=[]),  # upsert
        ]
        mock_sb.table.return_value = mock_table
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.patch(
                f"/v1/perfil/custos-fixos/{TEST_CUSTO_ID}/pagar",
                json={"competencia": "2026-09", "pago": True},
            )
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["pago"] is True
            assert data["result"]["competencia"] == "2026-09"
        finally:
            app.dependency_overrides.clear()


class TestPerfilAtualizarNaoApagaFoto:
    def test_atualizar_perfil_sem_foto_url_nao_limpa_foto_existente(self):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.update.return_value = mock_table
        mock_table.execute.side_effect = [
            MagicMock(data=[{  # _buscar_perfil_salao
                "id": str(uuid.uuid4()),
                "user_id": TEST_USER_ID,
                "nome_salao": "Salão",
                "nome_proprietaria": "Dona",
                "foto_url": "https://exemplo/foto.jpg",
                "telefone": "551199990000",
                "meta_faturamento_mensal": 9000.0,
            }]),
            MagicMock(data=[]),  # update
            MagicMock(data=[{  # obter_perfil (via _buscar_perfil_salao de novo)
                "id": str(uuid.uuid4()),
                "user_id": TEST_USER_ID,
                "nome_salao": "Salão Novo",
                "nome_proprietaria": "Dona",
                "foto_url": "https://exemplo/foto.jpg",
                "telefone": "551199990000",
                "meta_faturamento_mensal": 9500.0,
            }]),
        ]
        mock_sb.table.return_value = mock_table

        dados = PerfilUpdateIn(
            nome="Salão Novo",
            proprietaria="Dona",
            telefone_whatsapp="551199990000",
            meta_faturamento_mensal=9500.0,
        )
        perfil_service.atualizar_perfil(mock_sb, TEST_USER_ID, dados)

        campos_enviados = mock_table.update.call_args.args[0]
        assert "foto_url" not in campos_enviados
        assert campos_enviados["nome_salao"] == "Salão Novo"


class TestHorarioEmDoisTurnos:
    def test_aceita_pausa_entre_os_turnos(self):
        horario = HorarioDia(
            dia_semana=2,
            ativo=True,
            hora_inicio="08:00",
            hora_fim="12:00",
            hora_inicio_2="13:00",
            hora_fim_2="18:00",
        )
        assert horario.hora_inicio_2.isoformat() == "13:00:00"

    def test_rejeita_turnos_sobrepostos(self):
        with pytest.raises(ValueError, match="segundo turno"):
            HorarioDia(
                dia_semana=2,
                ativo=True,
                hora_inicio="08:00",
                hora_fim="12:00",
                hora_inicio_2="11:30",
                hora_fim_2="18:00",
            )


class TestPerfilCustosFixosEscopoPorUsuario:
    def _mock_custo(self):
        return {
            "id": TEST_CUSTO_ID,
            "user_id": TEST_USER_ID,
            "descricao": "Aluguel",
            "valor": 1200.0,
            "dia_vencimento": 5,
        }

    def test_editar_custo_fixo_filtra_por_user_id_no_update(self):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.update.return_value = mock_table
        mock_table.order.return_value = mock_table
        mock_table.execute.side_effect = [
            MagicMock(data=[self._mock_custo()]),  # _buscar_custo_fixo (checagem)
            MagicMock(data=[]),  # update
            MagicMock(data=[self._mock_custo()]),  # _buscar_custo_fixo (releitura)
            MagicMock(data=[]),  # checagem de pagamento do mês
        ]
        mock_sb.table.return_value = mock_table

        perfil_service.editar_custo_fixo(
            mock_sb, TEST_USER_ID, TEST_CUSTO_ID, CustoFixoPatchIn(valor=1300.0)
        )

        eq_calls = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in eq_calls

    def test_excluir_custo_fixo_filtra_por_user_id_no_delete(self):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.delete.return_value = mock_table
        mock_table.execute.side_effect = [
            MagicMock(data=[self._mock_custo()]),  # _buscar_custo_fixo
            MagicMock(data=[]),  # delete
        ]
        mock_sb.table.return_value = mock_table

        perfil_service.excluir_custo_fixo(mock_sb, TEST_USER_ID, TEST_CUSTO_ID)

        eq_calls = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in eq_calls

    def test_desmarcar_pagamento_filtra_por_user_id_no_delete(self):
        from app.schemas.perfil import CustoFixoPagarIn

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.delete.return_value = mock_table
        mock_table.execute.side_effect = [
            MagicMock(data=[self._mock_custo()]),  # _buscar_custo_fixo
            MagicMock(data=[]),  # delete
        ]
        mock_sb.table.return_value = mock_table

        perfil_service.pagar_custo_fixo(
            mock_sb,
            TEST_USER_ID,
            TEST_CUSTO_ID,
            CustoFixoPagarIn(competencia="2026-09", pago=False),
        )

        eq_calls = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in eq_calls
