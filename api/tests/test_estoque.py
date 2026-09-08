"""
Testes unitários e de integração para o módulo /estoque.
"""

import uuid
from unittest.mock import MagicMock
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.core.security import usuario_atual
from app.core.supabase_client import get_supabase
from app.schemas.estoque import ItemIn
from app.services import estoque_service


TEST_USER_ID = str(uuid.uuid4())
TEST_ITEM_ID = str(uuid.uuid4())


@pytest.fixture
def client():
    return TestClient(app)


class TestEstoqueEndpoints:
    def test_historico_preserva_zero_e_nao_reinterpreta_ajuste_antigo(self, client):
        sb = MagicMock()
        table = sb.table.return_value
        table.select.return_value = table
        table.eq.return_value = table
        table.order.return_value = table
        table.in_.return_value = table
        movimento = {
            "id": str(uuid.uuid4()), "item_id": TEST_ITEM_ID, "tipo": "ajuste",
            "quantidade": 0, "motivo": "Conferência", "atendimento_id": None,
            "criado_em": "2026-09-07T12:00:00Z",
        }
        table.execute.side_effect = [
            MagicMock(data=[
                {**movimento, "saldo_anterior": 6, "saldo_atual": 0},
                {**movimento, "id": str(uuid.uuid4()), "quantidade": 2, "motivo": "Estorno antigo"},
            ]),
            MagicMock(data=[{"id": TEST_ITEM_ID, "nome": "Creme"}]),
        ]
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: sb
        try:
            response = client.get("/v1/estoque/movimentacoes")
            assert response.status_code == 200
            atual, antigo = response.json()["result"]["movimentacoes"]
            assert (atual["saldo_anterior"], atual["saldo_atual"]) == (6, 0)
            assert antigo["saldo_anterior"] is None
            assert antigo["saldo_atual"] is None
            assert antigo["quantidade"] == 2
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.parametrize("contagem", [4, 0, 8, 6])
    def test_conferencia_define_saldo_e_grava_historico_no_mesmo_rpc(self, client, contagem):
        item = {
            "id": TEST_ITEM_ID, "nome": "Creme", "unidade": "un", "categoria": "outro",
            "quantidade_atual": 6, "quantidade_minima": 1, "custo_medio": 50,
            "custo_ultima_compra": 55, "status": "ok", "deficit": 0, "ativo": True,
        }
        sb = MagicMock()
        table = sb.table.return_value
        table.select.return_value = table
        table.eq.return_value = table
        table.execute.side_effect = [
            MagicMock(data=[item]),
            MagicMock(data=[{**item, "quantidade_atual": contagem}]),
        ]
        sb.rpc.return_value.execute.return_value = MagicMock(data=[{
            "id": TEST_ITEM_ID, "quantidade_atual": contagem,
        }])
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: sb
        try:
            response = client.post(f"/v1/estoque/itens/{TEST_ITEM_ID}/movimentacoes", json={
                "tipo": "ajuste", "quantidade": contagem, "motivo": "Conferência",
            })
            assert response.status_code == 200
            assert response.json()["result"]["quantidade_atual"] == contagem
            assert response.json()["result"]["custo_medio"] == 50
            assert response.json()["result"]["custo_ultima_compra"] == 55
            sb.rpc.assert_called_once_with("conferir_estoque", {
                "p_item_id": TEST_ITEM_ID, "p_quantidade": contagem,
                "p_motivo": "Conferência", "p_user_id": TEST_USER_ID,
            })
            table.insert.assert_not_called()
            table.update.assert_not_called()
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.parametrize("tipo,quantidade", [
        ("entrada", 0), ("saida", 0), ("entrada", -1), ("saida", -1), ("ajuste", -1),
    ])
    def test_movimentacao_invalida_nao_grava(self, client, tipo, quantidade):
        sb = MagicMock()
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: sb
        try:
            response = client.post(f"/v1/estoque/itens/{TEST_ITEM_ID}/movimentacoes", json={
                "tipo": tipo, "quantidade": quantidade,
            })
            assert response.status_code == 422
            sb.table.assert_not_called()
            sb.rpc.assert_not_called()
        finally:
            app.dependency_overrides.clear()

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

    def test_editar_item_remove_codigo_de_barras(self):
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
            "deficit": 0.0, "ativo": True, "codigo_barras": "789123",
        }
        mock_table.execute.side_effect = [
            MagicMock(data=[linha]),
            MagicMock(data=[]),
            MagicMock(data=[{**linha, "codigo_barras": None}]),
        ]
        mock_sb.table.return_value = mock_table

        estoque_service.editar(
            mock_sb, TEST_USER_ID, TEST_ITEM_ID, ItemPatchIn(codigo_barras=None)
        )

        assert mock_table.update.call_args.args[0] == {"codigo_barras": None}

    def test_editar_item_muda_para_rendimento_sem_alterar_saldo(self):
        from app.schemas.estoque import ItemPatchIn

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.update.return_value = mock_table
        linha = {
            "id": TEST_ITEM_ID, "user_id": TEST_USER_ID, "nome": "Creme", "unidade": "un",
            "categoria": "limpeza_pele", "quantidade_atual": 6.0, "quantidade_minima": 1.0,
            "custo_medio": 50.0, "custo_ultima_compra": 50.0, "status": "ok",
            "deficit": 0.0, "ativo": True, "codigo_barras": None,
            "modo_controle": "quantidade", "usos_por_unidade": None, "usos_minimos": 0,
        }
        mock_table.execute.side_effect = [
            MagicMock(data=[linha]),
            MagicMock(data=[]),
            MagicMock(data=[{**linha, "modo_controle": "rendimento_usos", "usos_por_unidade": 10, "usos_minimos": 10}]),
        ]
        mock_sb.table.return_value = mock_table

        estoque_service.editar(
            mock_sb,
            TEST_USER_ID,
            TEST_ITEM_ID,
            ItemPatchIn(
                unidade="un",
                modo_controle="rendimento_usos",
                usos_por_unidade=10,
                usos_minimos=10,
            ),
        )

        campos = mock_table.update.call_args.args[0]
        assert campos["modo_controle"] == "rendimento_usos"
        assert campos["usos_por_unidade"] == 10
        assert campos["usos_minimos"] == 10
        assert "quantidade_atual" not in campos

    def test_editar_item_em_gramas_exige_confirmacao_para_mudar_para_usos(self):
        from app.schemas.estoque import ItemPatchIn

        mock_sb = MagicMock()
        mock_table = MagicMock()
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.execute.return_value = MagicMock(data=[{
            "id": TEST_ITEM_ID, "nome": "Creme", "unidade": "g", "categoria": "limpeza_pele",
            "quantidade_atual": 100.0, "quantidade_minima": 0, "custo_medio": 50,
            "custo_ultima_compra": 50, "status": "ok", "deficit": 0, "ativo": True,
            "codigo_barras": None, "modo_controle": "quantidade",
        }])
        mock_sb.table.return_value = mock_table

        with pytest.raises(HTTPException) as erro:
            estoque_service.editar(
                mock_sb,
                TEST_USER_ID,
                TEST_ITEM_ID,
                ItemPatchIn(
                    unidade="un",
                    modo_controle="rendimento_usos",
                    usos_por_unidade=10,
                ),
            )

        assert erro.value.detail["codigo"] == "CONFERIR_UNIDADE_FISICA"


class TestRendimentoPorUsos:
    def test_calcula_capacidade_custo_e_alerta_pelo_total_de_usos(self):
        item = estoque_service._enriquecer_item({
            "id": TEST_ITEM_ID,
            "nome": "Creme",
            "unidade": "un",
            "quantidade_atual": 6,
            "quantidade_minima": 0,
            "custo_medio": 50,
            "modo_controle": "rendimento_usos",
            "usos_por_unidade": 10,
            "usos_minimos": 10,
        })

        assert item["usos_disponiveis"] == 60
        assert item["custo_por_uso"] == 5
        assert item["deficit_usos"] == 0
        assert item["status_rendimento"] == "ok"

    def test_cadastro_por_rendimento_exige_embalagem_e_usos_validos(self):
        valido = ItemIn(
            nome="Creme",
            unidade="un",
            categoria="outro",
            modo_controle="rendimento_usos",
            usos_por_unidade=10,
            usos_minimos=5,
        )
        assert valido.usos_por_unidade == 10

        with pytest.raises(ValidationError):
            ItemIn(
                nome="Creme em ml",
                unidade="ml",
                categoria="outro",
                modo_controle="rendimento_usos",
                usos_por_unidade=10,
            )

        with pytest.raises(ValidationError):
            ItemIn(
                nome="Creme antigo",
                unidade="un",
                categoria="outro",
                modo_controle="validade_atendimentos",
            )

    def test_api_rejeita_campos_e_rota_legados(self, client):
        app.dependency_overrides[usuario_atual] = lambda: TEST_USER_ID
        app.dependency_overrides[get_supabase] = lambda: MagicMock()
        try:
            body = {
                "nome": "Creme antigo",
                "unidade": "un",
                "categoria": "outro",
                "modo_controle": "validade_atendimentos",
                "duracao_atendimentos": 10,
            }
            assert client.post("/v1/estoque/itens", json=body).status_code == 422
            assert client.post(f"/v1/estoque/itens/{TEST_ITEM_ID}/abrir").status_code == 404
        finally:
            app.dependency_overrides.clear()

    def test_planejamento_explica_historico_agenda_e_embalagens(self):
        item = estoque_service._enriquecer_item({
            "id": TEST_ITEM_ID,
            "nome": "Creme",
            "unidade": "un",
            "quantidade_atual": 1,
            "quantidade_minima": 0,
            "custo_medio": 50,
            "modo_controle": "rendimento_usos",
            "usos_por_unidade": 10,
            "usos_minimos": 10,
        })

        planejamento = estoque_service._montar_planejamento_reposicao(
            [item],
            [{
                "item_id": TEST_ITEM_ID,
                "quantidade": 6,
                "quantidade_consumida": 60,
                "unidade_consumo": "uso",
            }],
            {TEST_ITEM_ID: 5},
            atendimentos_agendados=2,
        )

        assert len(planejamento) == 1
        sugestao = planejamento[0]
        # 10 de limite + 5 já agendados + 14 dias × 2 usos/dia − 10 atuais.
        assert sugestao["quantidade_sugerida"] == 33
        assert sugestao["embalagens_sugeridas"] == 4
        assert sugestao["unidade_consumo"] == "uso"
        assert "últimos 30 dias" in sugestao["base_calculo"]


class TestEstoqueExclusaoPorUsuario:
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
