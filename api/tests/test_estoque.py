"""
Testes unitários e de integração para o módulo /estoque.
"""

import uuid
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.security import usuario_atual
from app.core.supabase_client import get_supabase


TEST_USER_ID = str(uuid.uuid4())
TEST_ITEM_ID = str(uuid.uuid4())


@pytest.fixture
def client():
    return TestClient(app)


class TestEstoqueEndpoints:
    def test_listar_itens_estoque(self, client):
        mock_itens = [
            {
                "id": TEST_ITEM_ID,
                "user_id": TEST_USER_ID,
                "nome": "Cola adesiva para cílios",
                "unidade": "un",
                "categoria": "cilios",
                "quantidade_atual": 0.0,
                "quantidade_minima": 2.0,
                "custo_medio": 28.0,
                "custo_ultima_compra": 30.0,
                "status": "critico",
                "deficit": 2.0,
                "ativo": True,
                "codigo_barras": None,
            }
        ]

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.order.return_value = mock_table
        mock_table.execute.return_value = MagicMock(data=mock_itens)
        mock_sb.table.return_value = mock_table

        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.get("/v1/estoque/itens")
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["total_alertas"] == 1
            assert len(data["result"]["itens"]) == 1
            assert data["result"]["itens"][0]["status"] == "critico"
        finally:
            app.dependency_overrides.clear()

    def test_criar_movimentacao_entrada_recalcula_custo_medio(self, client):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.update.return_value = mock_table
        mock_table.insert.return_value = mock_table

        # Item atual: saldo 2, custo_medio 20.0
        # Entrada: 2 unidades a 30.0 -> novo saldo 4, novo custo_medio = (2*20 + 2*30)/4 = 25.0
        item_inicial = {
            "id": TEST_ITEM_ID,
            "user_id": TEST_USER_ID,
            "nome": "Cola adesiva para cílios",
            "unidade": "un",
            "categoria": "cilios",
            "quantidade_atual": 2.0,
            "quantidade_minima": 2.0,
            "custo_medio": 20.0,
            "custo_ultima_compra": 20.0,
            "status": "ok",
            "deficit": 0.0,
            "ativo": True,
            "codigo_barras": None,
        }
        item_pos_entrada = {
            **item_inicial,
            "quantidade_atual": 4.0,
            "custo_medio": 25.0,
            "custo_ultima_compra": 30.0,
        }

        mock_table.execute.side_effect = [
            MagicMock(data=[item_inicial]),     # buscar item antes
            MagicMock(data=[]),                 # insert movimentacao
            MagicMock(data=[]),                 # update custo (quantidade_atual já foi pelo RPC)
            MagicMock(data=[item_pos_entrada]), # buscar item depois
        ]
        mock_sb.table.return_value = mock_table
        mock_sb.rpc.return_value.execute.return_value = MagicMock(
            data=[{"quantidade_atual": 4.0}]
        )

        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.post(
                f"/v1/estoque/itens/{TEST_ITEM_ID}/movimentacoes",
                json={
                    "tipo": "entrada",
                    "quantidade": 2,
                    "motivo": "Compra fornecedor",
                    "custo_unitario": 30.0,
                },
            )
            assert response.status_code == 200
            data = response.json()
            assert data["result"]["quantidade_atual"] == 4.0
            assert data["result"]["custo_medio"] == 25.0
            assert data["result"]["custo_ultima_compra"] == 30.0
            mock_sb.rpc.assert_called_once_with(
                "ajustar_estoque",
                {
                    "p_item_id": TEST_ITEM_ID,
                    "p_delta": 2.0,
                    "p_permitir_negativo": True,
                    "p_user_id": TEST_USER_ID,
                },
            )
        finally:
            app.dependency_overrides.clear()

    def test_saida_manual_sem_saldo_retorna_409(self, client):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table

        item_inicial = {
            "id": TEST_ITEM_ID,
            "user_id": TEST_USER_ID,
            "nome": "Cola adesiva para cílios",
            "unidade": "un",
            "categoria": "cilios",
            "quantidade_atual": 1.0,
            "quantidade_minima": 2.0,
            "custo_medio": 20.0,
            "custo_ultima_compra": 20.0,
            "status": "alerta",
            "deficit": 1.0,
            "ativo": True,
            "codigo_barras": None,
        }

        mock_table.execute.return_value = MagicMock(data=[item_inicial])
        mock_sb.table.return_value = mock_table

        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.post(
                f"/v1/estoque/itens/{TEST_ITEM_ID}/movimentacoes",
                json={
                    "tipo": "saida",
                    "quantidade": 5,
                    "motivo": "Uso avulso",
                },
            )
            assert response.status_code == 409
            data = response.json()
            assert data["codigo"] == "ESTOQUE_INSUFICIENTE"
            assert "faltantes" in data["result"]
        finally:
            app.dependency_overrides.clear()

    def test_saida_perde_corrida_no_rpc_retorna_409_com_saldo_atual(self, client):
        """
        A pré-checagem em Python (`qtd_atual < quantidade`) só evita o caso óbvio —
        quem trava de verdade é o RPC atômico. Se outra baixa correu entre a
        pré-checagem e o RPC, `ajustar_estoque` devolve vazio (sem `permitir_negativo`)
        e o serviço precisa reconsultar o saldo real para o 409, não usar o valor
        já obsoleto da pré-checagem.
        """
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table

        item_inicial = {
            "id": TEST_ITEM_ID,
            "user_id": TEST_USER_ID,
            "nome": "Cola adesiva para cílios",
            "unidade": "un",
            "categoria": "cilios",
            "quantidade_atual": 5.0,
            "quantidade_minima": 2.0,
            "custo_medio": 20.0,
            "custo_ultima_compra": 20.0,
            "status": "ok",
            "deficit": 0.0,
            "ativo": True,
            "codigo_barras": None,
        }

        mock_table.execute.side_effect = [
            MagicMock(data=[item_inicial]),          # buscar item antes (pré-checagem passa: 5 >= 3)
            MagicMock(data=[{"quantidade_atual": 0.0}]),  # reconsulta pós-RPC vazio
        ]
        mock_sb.table.return_value = mock_table
        mock_sb.rpc.return_value.execute.return_value = MagicMock(data=[])  # RPC travou, sem linha

        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.post(
                f"/v1/estoque/itens/{TEST_ITEM_ID}/movimentacoes",
                json={"tipo": "saida", "quantidade": 3, "motivo": "Uso avulso"},
            )
            assert response.status_code == 409
            data = response.json()
            assert data["codigo"] == "ESTOQUE_INSUFICIENTE"
            assert data["result"]["faltantes"][0]["quantidade_disponivel"] == 0.0
            mock_sb.rpc.assert_called_once_with(
                "ajustar_estoque",
                {
                    "p_item_id": TEST_ITEM_ID,
                    "p_delta": -3.0,
                    "p_permitir_negativo": False,
                    "p_user_id": TEST_USER_ID,
                },
            )
        finally:
            app.dependency_overrides.clear()


class TestEstoqueEscopoPorUsuario:
    """
    `_buscar_item` já filtra por `user_id` na leitura, mas o `service_role`
    bypassa RLS — `update`/`delete` precisam repetir o filtro (mesma convenção
    de `gastos_service`/`atendimentos_service`).
    """

    def test_editar_item_filtra_por_user_id_no_update(self):
        from app.services import estoque_service
        from app.schemas.estoque import ItemPatchIn

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.update.return_value = mock_table
        linha = {
            "id": TEST_ITEM_ID, "user_id": TEST_USER_ID, "nome": "Cola", "unidade": "un",
            "categoria": "cilios", "quantidade_atual": 2.0, "quantidade_minima": 1.0,
            "custo_medio": 20.0, "custo_ultima_compra": 20.0, "status": "ok",
            "deficit": 0.0, "ativo": True, "codigo_barras": None,
        }
        mock_table.execute.side_effect = [
            MagicMock(data=[linha]),  # _buscar_item
            MagicMock(data=[]),       # update
            MagicMock(data=[linha]),  # _buscar_item de novo (retorno)
        ]
        mock_sb.table.return_value = mock_table

        estoque_service.editar(mock_sb, TEST_USER_ID, TEST_ITEM_ID, ItemPatchIn(nome="Cola nova"))

        chamadas_eq = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in chamadas_eq

    def test_excluir_item_sem_movimentacao_filtra_por_user_id_no_delete(self):
        from app.services import estoque_service

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.limit.return_value = mock_table
        mock_table.delete.return_value = mock_table
        linha = {
            "id": TEST_ITEM_ID, "user_id": TEST_USER_ID, "nome": "Cola", "unidade": "un",
            "categoria": "cilios", "quantidade_atual": 2.0, "quantidade_minima": 1.0,
            "custo_medio": 20.0, "custo_ultima_compra": 20.0, "status": "ok",
            "deficit": 0.0, "ativo": True, "codigo_barras": None,
        }
        mock_table.execute.side_effect = [
            MagicMock(data=[linha]),  # _buscar_item
            MagicMock(data=[]),       # select movimentacoes (nenhuma)
            MagicMock(data=[]),       # delete
        ]
        mock_sb.table.return_value = mock_table

        estoque_service.excluir(mock_sb, TEST_USER_ID, TEST_ITEM_ID)

        chamadas_eq = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in chamadas_eq

    def test_excluir_item_com_movimentacao_filtra_por_user_id_no_soft_delete(self):
        from app.services import estoque_service

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.limit.return_value = mock_table
        mock_table.update.return_value = mock_table
        linha = {
            "id": TEST_ITEM_ID, "user_id": TEST_USER_ID, "nome": "Cola", "unidade": "un",
            "categoria": "cilios", "quantidade_atual": 2.0, "quantidade_minima": 1.0,
            "custo_medio": 20.0, "custo_ultima_compra": 20.0, "status": "ok",
            "deficit": 0.0, "ativo": True, "codigo_barras": None,
        }
        mock_table.execute.side_effect = [
            MagicMock(data=[linha]),                    # _buscar_item
            MagicMock(data=[{"id": str(uuid.uuid4())}]),  # select movimentacoes (existe)
            MagicMock(data=[]),                          # update ativo=False
        ]
        mock_sb.table.return_value = mock_table

        estoque_service.excluir(mock_sb, TEST_USER_ID, TEST_ITEM_ID)

        chamadas_eq = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in chamadas_eq
