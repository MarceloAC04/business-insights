"""
Testes unitários e de integração para o módulo /kits (endpoints-backend.md §6).
"""

import uuid
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.security import usuario_atual
from app.core.supabase_client import get_supabase
from app.services import kits_service
from app.schemas.kits import KitIn, KitPatchIn, MontarKitIn, VenderKitIn


TEST_USER_ID = str(uuid.uuid4())
TEST_KIT_ID = str(uuid.uuid4())
TEST_ITEM_ID = str(uuid.uuid4())


@pytest.fixture
def client():
    return TestClient(app)


def _mock_table_dispatcher(por_tabela: dict[str, list[MagicMock]]):
    """
    Uma tabela mockada só, mas com respostas dadas por nome de tabela — a
    ordem dentro de cada lista é a ordem das chamadas àquela tabela.
    Mesma necessidade dos testes de atendimentos: várias tabelas diferentes
    (`kits`, `kit_itens`, `kit_vendas`, `estoque_itens`, `estoque_movimentacoes`)
    entram na mesma chamada de serviço.
    """
    contadores = {nome: 0 for nome in por_tabela}
    mock_table = MagicMock()
    mock_table.select.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.neq.return_value = mock_table
    mock_table.in_.return_value = mock_table
    mock_table.order.return_value = mock_table
    mock_table.limit.return_value = mock_table
    mock_table.insert.return_value = mock_table
    mock_table.update.return_value = mock_table
    mock_table.delete.return_value = mock_table

    tabela_atual = {"nome": None}

    def _table(nome):
        tabela_atual["nome"] = nome
        return mock_table

    def _execute():
        nome = tabela_atual["nome"]
        respostas = por_tabela.get(nome, [])
        i = contadores[nome]
        contadores[nome] = i + 1
        return respostas[i]

    mock_table.execute.side_effect = _execute

    mock_sb = MagicMock()
    mock_sb.table.side_effect = _table
    return mock_sb, mock_table


class TestKitsListarObter:
    def test_listar_calcula_campos_derivados(self, client):
        kit_row = {
            "id": TEST_KIT_ID, "nome": "Kit cuidado pós-cílios", "preco_venda": 45.0,
            "quantidade_montada": 3, "ativo": True,
        }
        item = {
            "id": TEST_ITEM_ID, "nome": "Removedor", "unidade": "un",
            "quantidade_atual": 14.0, "custo_medio": 3.5,
        }
        mock_sb, _ = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row])],
            "kit_itens": [MagicMock(data=[
                {"kit_id": TEST_KIT_ID, "item_estoque_id": TEST_ITEM_ID, "quantidade": 2.0}
            ])],
            "estoque_itens": [MagicMock(data=[item])],
        })
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: mock_sb

        try:
            response = client.get("/v1/kits")
            assert response.status_code == 200
            data = response.json()["result"]["kits"][0]
            assert data["custo_total"] == 7.0  # 2 * 3.5
            assert data["margem"] == 38.0  # 45 - 7
            assert data["quantidade_montavel"] == 7.0  # floor(14 / 2)
            assert data["disponivel"] is True
        finally:
            app.dependency_overrides.clear()


class TestKitsCriarEditarExcluir:
    def test_criar_kit_insere_composicao(self):
        kit_criado = {"id": TEST_KIT_ID}
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 0, "ativo": True}
        mock_sb, mock_table = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_criado]), MagicMock(data=[kit_row])],
            "kit_itens": [MagicMock(data=[]), MagicMock(data=[])],
        })

        resultado = kits_service.criar(
            mock_sb, TEST_USER_ID,
            KitIn(nome="Kit X", preco_venda=40.0, itens=[{"item_estoque_id": TEST_ITEM_ID, "quantidade": 1}]),
        )
        assert resultado["id"] == TEST_KIT_ID
        mock_table.insert.assert_any_call({
            "user_id": TEST_USER_ID, "nome": "Kit X", "preco_venda": 40.0,
            "quantidade_montada": 0, "ativo": True,
        })

    def test_editar_kit_filtra_por_user_id_no_update(self):
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 0, "ativo": True}
        mock_sb, mock_table = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row]), MagicMock(data=[]), MagicMock(data=[kit_row])],
            "kit_itens": [MagicMock(data=[])],
        })

        kits_service.editar(mock_sb, TEST_USER_ID, TEST_KIT_ID, KitPatchIn(nome="Kit Y"))

        chamadas_eq = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in chamadas_eq

    def test_excluir_sem_movimento_apaga_de_verdade(self):
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 0, "ativo": True}
        mock_sb, mock_table = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row]), MagicMock(data=[])],
            "kit_vendas": [MagicMock(data=[])],
            "kit_itens": [MagicMock(data=[])],
        })

        kits_service.excluir(mock_sb, TEST_USER_ID, TEST_KIT_ID)

        mock_table.delete.assert_any_call()
        chamadas_eq = [c.args for c in mock_table.eq.call_args_list]
        assert ("user_id", TEST_USER_ID) in chamadas_eq

    def test_excluir_com_montagem_faz_soft_delete(self):
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 2, "ativo": True}
        mock_sb, mock_table = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row]), MagicMock(data=[])],
            "kit_vendas": [MagicMock(data=[])],
        })

        kits_service.excluir(mock_sb, TEST_USER_ID, TEST_KIT_ID)

        mock_table.update.assert_any_call({"ativo": False})


@pytest.mark.skip(reason="Substituído pela RPC transacional da migração 014; os cenários atômicos estão em test_fluxos_estoque_atomicos.py e database/tests.")
class TestKitsMontar:
    def _item(self, quantidade_atual=10.0):
        return {
            "id": TEST_ITEM_ID, "nome": "Removedor", "unidade": "un",
            "quantidade_atual": quantidade_atual, "custo_medio": 3.5,
        }

    def test_montar_sem_saldo_retorna_409_sem_chamar_rpc(self):
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 0, "ativo": True}
        mock_sb, _ = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row])],
            "kit_itens": [MagicMock(data=[
                {"kit_id": TEST_KIT_ID, "item_estoque_id": TEST_ITEM_ID, "quantidade": 5.0}
            ])],
            "estoque_itens": [MagicMock(data=[self._item(quantidade_atual=2.0)])],
        })

        with pytest.raises(Exception) as exc_info:
            kits_service.montar(mock_sb, TEST_USER_ID, TEST_KIT_ID, MontarKitIn(quantidade=1))
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["codigo"] == "ESTOQUE_INSUFICIENTE"
        mock_sb.rpc.assert_not_called()

    def test_montar_happy_path_chama_rpc_e_incrementa_quantidade_montada(self):
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 3, "ativo": True}
        mock_sb, mock_table = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row]), MagicMock(data=[kit_row]), MagicMock(data=[]), MagicMock(data=[kit_row])],
            "kit_itens": [
                MagicMock(data=[{"kit_id": TEST_KIT_ID, "item_estoque_id": TEST_ITEM_ID, "quantidade": 2.0}]),
                MagicMock(data=[{"kit_id": TEST_KIT_ID, "item_estoque_id": TEST_ITEM_ID, "quantidade": 2.0}]),
            ],
            "estoque_itens": [MagicMock(data=[self._item(quantidade_atual=10.0)]), MagicMock(data=[self._item(quantidade_atual=8.0)])],
            "estoque_movimentacoes": [MagicMock(data=[])],
        })
        mock_sb.rpc.return_value.execute.return_value = MagicMock(data=[{"quantidade_atual": 8.0}])

        kits_service.montar(mock_sb, TEST_USER_ID, TEST_KIT_ID, MontarKitIn(quantidade=1))

        mock_sb.rpc.assert_called_once_with(
            "ajustar_estoque",
            {"p_item_id": TEST_ITEM_ID, "p_delta": -2.0, "p_permitir_negativo": False, "p_user_id": TEST_USER_ID},
        )
        mock_table.update.assert_any_call({"quantidade_montada": 4.0})

    def test_montar_perde_corrida_no_rpc_desfaz_ja_decrementados(self):
        """
        Kit com dois itens na composição: o primeiro decrementa ok, o segundo
        perde a corrida no RPC (outra baixa consumiu o saldo entre a
        pré-checagem e o RPC) — o primeiro precisa ser desfeito (rollback),
        não pode ficar com baixa parcial gravada.
        """
        item2_id = str(uuid.uuid4())
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 0, "ativo": True}
        item1 = self._item(quantidade_atual=10.0)
        item2 = {"id": item2_id, "nome": "Fita", "unidade": "cx", "quantidade_atual": 5.0, "custo_medio": 1.0}

        mock_sb, _ = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row])],
            "kit_itens": [MagicMock(data=[
                {"kit_id": TEST_KIT_ID, "item_estoque_id": TEST_ITEM_ID, "quantidade": 2.0},
                {"kit_id": TEST_KIT_ID, "item_estoque_id": item2_id, "quantidade": 5.0},
            ])],
            "estoque_itens": [
                MagicMock(data=[item1, item2]),  # saldos (pré-checagem, 1 select com in_)
                MagicMock(data=[{"quantidade_atual": 0.0}]),  # reconsulta pós-RPC do item2
            ],
        })
        # 1a chamada (item1, delta -2): sucesso. 2a chamada (item2, delta -5): trava (vazio).
        # 3a chamada: rollback do item1 (delta +2).
        mock_sb.rpc.return_value.execute.side_effect = [
            MagicMock(data=[{"quantidade_atual": 8.0}]),
            MagicMock(data=[]),
            MagicMock(data=[{"quantidade_atual": 10.0}]),
        ]

        with pytest.raises(Exception) as exc_info:
            kits_service.montar(mock_sb, TEST_USER_ID, TEST_KIT_ID, MontarKitIn(quantidade=1))
        assert exc_info.value.status_code == 409
        assert mock_sb.rpc.call_count == 3
        ultima_chamada = mock_sb.rpc.call_args_list[2]
        assert ultima_chamada.args[1]["p_delta"] == 2.0
        assert ultima_chamada.args[1]["p_permitir_negativo"] is True


@pytest.mark.skip(reason="Substituído pela RPC transacional da migração 014; os cenários atômicos estão em test_fluxos_estoque_atomicos.py e database/tests.")
class TestKitsVender:
    def test_vender_mais_que_montado_retorna_kit_nao_montado(self):
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 1, "ativo": True}
        mock_sb, _ = _mock_table_dispatcher({"kits": [MagicMock(data=[kit_row])]})

        with pytest.raises(Exception) as exc_info:
            kits_service.vender(mock_sb, TEST_USER_ID, TEST_KIT_ID, VenderKitIn(quantidade=3, forma_pagamento="pix"))
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["codigo"] == "KIT_NAO_MONTADO"
        assert exc_info.value.detail["result"]["quantidade_montada"] == 1.0

    def test_vender_happy_path_decrementa_e_grava_snapshot(self):
        kit_row = {"id": TEST_KIT_ID, "nome": "Kit X", "preco_venda": 40.0, "quantidade_montada": 3, "ativo": True}
        composicao_resp = MagicMock(data=[{"kit_id": TEST_KIT_ID, "item_estoque_id": TEST_ITEM_ID, "quantidade": 2.0}])
        saldo_resp = MagicMock(data=[self._item_venda()])
        mock_sb, mock_table = _mock_table_dispatcher({
            "kits": [MagicMock(data=[kit_row]), MagicMock(data=[]), MagicMock(data=[kit_row])],
            "kit_itens": [composicao_resp, composicao_resp],
            "estoque_itens": [saldo_resp, saldo_resp],
            "kit_vendas": [MagicMock(data=[])],
        })

        kits_service.vender(mock_sb, TEST_USER_ID, TEST_KIT_ID, VenderKitIn(quantidade=1, forma_pagamento="pix"))

        mock_table.update.assert_any_call({"quantidade_montada": 2.0})
        chamada_insert_venda = [c for c in mock_table.insert.call_args_list if "nome_snapshot" in c.args[0]][0]
        assert chamada_insert_venda.args[0]["preco_unitario"] == 40.0
        assert chamada_insert_venda.args[0]["custo_snapshot"] == 7.0  # 2 * 3.5

    def _item_venda(self):
        return {"id": TEST_ITEM_ID, "nome": "Removedor", "unidade": "un", "quantidade_atual": 10.0, "custo_medio": 3.5}
