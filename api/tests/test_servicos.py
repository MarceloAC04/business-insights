"""
Testes unitários e de integração para o módulo /servicos (endpoints-backend.md §8).
"""

import uuid
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.security import usuario_atual
from app.core.supabase_client import get_supabase
from app.schemas.servicos import ServicoPatchIn
from app.services import servicos_service


TEST_USER_ID = str(uuid.uuid4())
TEST_SERVICO_ID = str(uuid.uuid4())
TEST_ITEM_ID = str(uuid.uuid4())


@pytest.fixture
def client():
    return TestClient(app)


def _mock_table_dispatcher(por_tabela: dict[str, list[MagicMock]]):
    """Dispatcha `.execute()` por nome de tabela, um resultado por chamada."""
    mock_sb = MagicMock()
    mock_table = MagicMock()
    contadores: dict[str, int] = {nome: 0 for nome in por_tabela}
    estado = {"tabela_atual": None}

    def _table_impl(nome):
        estado["tabela_atual"] = nome
        return mock_table

    def _execute_impl(*args, **kwargs):
        nome = estado["tabela_atual"]
        i = contadores[nome]
        contadores[nome] = i + 1
        return por_tabela[nome][i]

    mock_table.select.return_value = mock_table
    mock_table.insert.return_value = mock_table
    mock_table.update.return_value = mock_table
    mock_table.delete.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.in_.return_value = mock_table
    mock_table.order.return_value = mock_table
    mock_table.limit.return_value = mock_table
    mock_table.single.return_value = mock_table
    mock_table.execute = MagicMock(side_effect=_execute_impl)
    mock_sb.table = MagicMock(side_effect=_table_impl)
    return mock_sb, mock_table


class TestServicosListar:
    def test_listar_resolve_produtos_padrao(self):
        mock_sb, _ = _mock_table_dispatcher({
            "servicos": [MagicMock(data=[{
                "id": TEST_SERVICO_ID, "nome": "Extensão de cílios", "preco": 180.0,
                "duracao_minutos": 90, "ativo": True,
            }])],
            "servico_produtos_padrao": [MagicMock(data=[{
                "servico_id": TEST_SERVICO_ID, "item_estoque_id": TEST_ITEM_ID, "quantidade": 1.0,
            }])],
            "estoque_itens": [MagicMock(data=[{
                "id": TEST_ITEM_ID, "nome": "Fio mink 0.07", "unidade": "un",
            }])],
        })

        resultado = servicos_service.listar(mock_sb, TEST_USER_ID)

        assert len(resultado["servicos"]) == 1
        assert resultado["servicos"][0]["produtos_padrao"][0]["nome"] == "Fio mink 0.07"


class TestServicosCriarEditarExcluir:
    def test_editar_filtra_por_user_id_no_update(self):
        mock_sb, mock_table = _mock_table_dispatcher({
            "servicos": [
                MagicMock(data=[{  # _buscar_servico (checagem)
                    "id": TEST_SERVICO_ID, "nome": "Extensão", "preco": 180.0,
                    "duracao_minutos": 90, "ativo": True,
                }]),
                MagicMock(data=[]),  # update
                MagicMock(data=[{  # _buscar_servico (releitura)
                    "id": TEST_SERVICO_ID, "nome": "Extensão premium", "preco": 200.0,
                    "duracao_minutos": 90, "ativo": True,
                }]),
            ],
            "servico_produtos_padrao": [MagicMock(data=[])],
        })

        servicos_service.editar(
            mock_sb, TEST_USER_ID, TEST_SERVICO_ID,
            ServicoPatchIn(nome="Extensão premium", preco=200.0),
        )

        eq_calls = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in eq_calls

    def test_excluir_sempre_faz_soft_delete_e_filtra_por_user_id(self):
        mock_sb, mock_table = _mock_table_dispatcher({
            "servicos": [
                MagicMock(data=[{  # _buscar_servico
                    "id": TEST_SERVICO_ID, "nome": "Extensão", "preco": 180.0,
                    "duracao_minutos": 90, "ativo": True,
                }]),
                MagicMock(data=[]),  # update ativo=False
            ],
        })

        servicos_service.excluir(mock_sb, TEST_USER_ID, TEST_SERVICO_ID)

        mock_table.update.assert_called_once_with({"ativo": False})
        eq_calls = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in eq_calls
        mock_table.delete.assert_not_called()


class TestServicosEndpoints:
    def test_criar_com_produto_padrao_inativo_retorna_404(self, client):
        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.in_.return_value = mock_table
        mock_table.execute.return_value = MagicMock(data=[{"id": TEST_ITEM_ID, "ativo": False}])
        mock_sb.table.return_value = mock_table
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.post(
                "/v1/servicos",
                json={
                    "nome": "Extensão",
                    "preco": 180.0,
                    "duracao_minutos": 90,
                    "produtos_padrao": [{"item_estoque_id": TEST_ITEM_ID, "quantidade": 1}],
                },
            )
            assert response.status_code == 404
            assert response.json()["codigo"] == "RECURSO_NAO_ENCONTRADO"
        finally:
            app.dependency_overrides.clear()

    def test_criar_com_item_repetido_retorna_422(self, client):
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: MagicMock()

        try:
            response = client.post(
                "/v1/servicos",
                json={
                    "nome": "Extensão",
                    "preco": 180.0,
                    "duracao_minutos": 90,
                    "produtos_padrao": [
                        {"item_estoque_id": TEST_ITEM_ID, "quantidade": 1},
                        {"item_estoque_id": TEST_ITEM_ID, "quantidade": 2},
                    ],
                },
            )
            assert response.status_code == 422
        finally:
            app.dependency_overrides.clear()

    def test_criar_com_duracao_zero_retorna_422(self, client):
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: MagicMock()

        try:
            response = client.post(
                "/v1/servicos",
                json={"nome": "Extensão", "preco": 180.0, "duracao_minutos": 0, "produtos_padrao": []},
            )
            assert response.status_code == 422
        finally:
            app.dependency_overrides.clear()
