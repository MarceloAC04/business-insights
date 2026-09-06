"""
Testes unitários para o serviço de `atendimentos` — chamam
`app.services.atendimentos_service` direto (sem TestClient), com um Supabase
fake que despacha `.execute()` por nome de tabela, e um `.rpc()` fake para o
`ajustar_estoque` atômico.

Cobre principalmente a corrida de estoque (§A5 + RPC atômico), que é a parte
crítica em dinheiro/saldo deste módulo — CRUD puro (listar/obter/editar/
excluir) fica com cobertura mais rasa, de guarda de status.
"""

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.schemas.atendimentos import AtendimentoBodyIn, FinalizarBodyIn, MaterialEntradaIn, ServicoEntradaIn
from app.services import atendimentos_service as service


TEST_USER_ID = str(uuid.uuid4())
ATENDIMENTO_ID = str(uuid.uuid4())
ITEM_A = str(uuid.uuid4())
ITEM_B = str(uuid.uuid4())


def _fake_supabase(table_data: dict[str, list], rpc_data: list | None = None) -> MagicMock:
    """
    `table_data`: {nome_tabela: [MagicMock(data=...), ...]} — cada `.execute()`
    numa tabela consome a próxima resposta da lista, na ordem em que o código
    de produção chama.
    `rpc_data`: lista de respostas consumida na ordem das chamadas de
    `.rpc("ajustar_estoque", ...).execute()`, seja qual for o nome do RPC.
    """
    contadores = {nome: 0 for nome in table_data}
    mock_sb = MagicMock()

    def table_side_effect(nome):
        m = MagicMock()
        for metodo in ("select", "eq", "neq", "gte", "lte", "lt", "in_", "order", "insert", "update", "delete"):
            getattr(m, metodo).return_value = m

        def execute():
            idx = contadores[nome]
            contadores[nome] += 1
            return table_data[nome][idx]

        m.execute.side_effect = execute
        return m

    mock_sb.table.side_effect = table_side_effect

    if rpc_data is not None:
        rpc_contador = {"i": 0}

        def rpc_side_effect(_nome, _params):
            m = MagicMock()

            def execute():
                idx = rpc_contador["i"]
                rpc_contador["i"] += 1
                return rpc_data[idx]

            m.execute.side_effect = execute
            return m

        mock_sb.rpc.side_effect = rpc_side_effect

    return mock_sb


def _body_avulso(nome="Cliente Teste", preco=50.0):
    return AtendimentoBodyIn(
        cliente_nome=nome,
        cliente_telefone=None,
        data=datetime.now(timezone.utc),
        servicos=[ServicoEntradaIn(nome="Corte", preco=preco)],
    )


class TestCriarListarObter:
    def test_criar_com_servico_avulso(self):
        supabase = _fake_supabase({
            "atendimentos": [MagicMock(data=[{
                "id": ATENDIMENTO_ID, "nome_cliente": "Cliente Teste", "telefone_cliente": None,
                "data": "2026-01-01T10:00:00-03:00", "status": "agendado",
            }])],
            "atendimento_servicos": [
                MagicMock(data=[]),  # insert
                MagicMock(data=[{"servico_id": None, "nome_servico": "Corte", "preco_snapshot": 50.0}]),  # select em _montar_saida
            ],
            "atendimento_insumos": [MagicMock(data=[])],
        })

        resultado = service.criar(supabase, TEST_USER_ID, _body_avulso())

        assert resultado["id"] == ATENDIMENTO_ID
        assert resultado["total_servicos"] == 50.0
        assert resultado["saldo"] == 50.0

    def test_criar_servico_catalogo_invalido_422(self):
        supabase = _fake_supabase({
            "servicos": [MagicMock(data=[])],  # nenhum serviço encontrado no catálogo
        })
        body = AtendimentoBodyIn(
            cliente_nome="Cliente",
            data=datetime.now(timezone.utc),
            servicos=[ServicoEntradaIn(servico_id=str(uuid.uuid4()))],
        )

        with pytest.raises(HTTPException) as exc:
            service.criar(supabase, TEST_USER_ID, body)
        assert exc.value.status_code == 422
        assert exc.value.detail["codigo"] == "VALIDACAO_INVALIDA"

    def test_obter_nao_encontrado_404(self):
        supabase = _fake_supabase({"atendimentos": [MagicMock(data=[])]})
        with pytest.raises(HTTPException) as exc:
            service.obter(supabase, TEST_USER_ID, ATENDIMENTO_ID)
        assert exc.value.status_code == 404

    def test_listar_saldo_liquido_ignora_cancelado(self):
        linhas = [
            {"id": "a1", "nome_cliente": "A", "telefone_cliente": None, "data": "2026-01-01", "status": "finalizado"},
            {"id": "a2", "nome_cliente": "B", "telefone_cliente": None, "data": "2026-01-02", "status": "cancelado"},
        ]
        supabase = _fake_supabase({
            "atendimentos": [MagicMock(data=linhas)],
            "atendimento_servicos": [
                MagicMock(data=[{"servico_id": None, "nome_servico": "X", "preco_snapshot": 100.0}]),
                MagicMock(data=[{"servico_id": None, "nome_servico": "Y", "preco_snapshot": 200.0}]),
            ],
            "atendimento_insumos": [MagicMock(data=[]), MagicMock(data=[])],
        })

        resultado = service.listar(supabase, TEST_USER_ID, "2026-01-01", "2026-01-31", None)

        assert resultado["quantidade"] == 2
        # só o finalizado (100.0) entra no saldo líquido — o cancelado (200.0) fica de fora
        assert resultado["saldo_liquido"] == 100.0


class TestEditarExcluir:
    def test_editar_cancelado_bloqueia_409(self):
        supabase = _fake_supabase({
            "atendimentos": [MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "cancelado"}])],
        })
        with pytest.raises(HTTPException) as exc:
            service.editar(supabase, TEST_USER_ID, ATENDIMENTO_ID, _body_avulso())
        assert exc.value.status_code == 409
        assert exc.value.detail["codigo"] == "ATENDIMENTO_STATUS_INVALIDO"

    def test_excluir_nao_agendado_bloqueia_409(self):
        supabase = _fake_supabase({
            "atendimentos": [MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "finalizado"}])],
        })
        with pytest.raises(HTTPException) as exc:
            service.excluir(supabase, TEST_USER_ID, ATENDIMENTO_ID)
        assert exc.value.status_code == 409

    def test_excluir_agendado_ok(self):
        supabase = _fake_supabase({
            "atendimentos": [
                MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "agendado"}]),  # _buscar_atendimento
                MagicMock(data=[]),  # delete
            ],
        })
        service.excluir(supabase, TEST_USER_ID, ATENDIMENTO_ID)
        # não levanta — sucesso


class TestFinalizarEstoque:
    def _body_finalizar(self, quantidade=2.0, confirmar=False):
        return FinalizarBodyIn(
            materiais=[MaterialEntradaIn(item_estoque_id=ITEM_A, quantidade=quantidade)],
            confirmar_estoque_insuficiente=confirmar,
        )

    def _item_estoque(self, item_id, quantidade_atual=10.0):
        return {"id": item_id, "nome": "Insumo", "unidade": "un", "quantidade_atual": quantidade_atual, "custo_medio": 5.0}

    def test_finalizar_agendado_status_invalido(self):
        supabase = _fake_supabase({
            "atendimentos": [MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "finalizado"}])],
        })
        with pytest.raises(HTTPException) as exc:
            service.finalizar(supabase, TEST_USER_ID, ATENDIMENTO_ID, self._body_finalizar())
        assert exc.value.status_code == 409
        assert exc.value.detail["codigo"] == "ATENDIMENTO_STATUS_INVALIDO"

    def test_finalizar_primeira_passada_estoque_insuficiente_409(self):
        # quantidade_atual (1) < quantidade pedida (2) — pré-checagem via leitura
        # em lote já barra antes de chamar o RPC, sem confirmar_estoque_insuficiente.
        supabase = _fake_supabase({
            "atendimentos": [MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "agendado"}])],
            "estoque_itens": [MagicMock(data=[self._item_estoque(ITEM_A, quantidade_atual=1.0)])],
        })
        with pytest.raises(HTTPException) as exc:
            service.finalizar(supabase, TEST_USER_ID, ATENDIMENTO_ID, self._body_finalizar(quantidade=2.0))
        assert exc.value.status_code == 409
        assert exc.value.detail["codigo"] == "ESTOQUE_INSUFICIENTE"
        assert exc.value.detail["result"]["faltantes"][0]["item_estoque_id"] == ITEM_A

    def test_finalizar_happy_path_chama_rpc_atomico(self):
        supabase = _fake_supabase(
            table_data={
                "atendimentos": [
                    MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "agendado"}]),  # _buscar_atendimento
                    MagicMock(data=[]),  # update status finalizado
                    MagicMock(data=[{
                        "id": ATENDIMENTO_ID, "nome_cliente": "Cliente Teste", "telefone_cliente": None,
                        "data": "2026-01-01T10:00:00-03:00", "status": "finalizado",
                    }]),  # obter()'s _buscar_atendimento
                ],
                "estoque_itens": [MagicMock(data=[self._item_estoque(ITEM_A, quantidade_atual=10.0)])],
                "atendimento_insumos": [
                    MagicMock(data=[]),  # insert linhas_insumo
                    MagicMock(data=[]),  # select em _montar_saida (obter final)
                ],
                "estoque_movimentacoes": [MagicMock(data=[])],  # insert saida
                "atendimento_servicos": [
                    MagicMock(data=[]),  # select servico_id (sem servico_id -> loop pula)
                    MagicMock(data=[{"servico_id": None, "nome_servico": "Corte", "preco_snapshot": 50.0}]),  # obter() final
                ],
            },
            rpc_data=[MagicMock(data=[{"id": ITEM_A, "quantidade_atual": 8.0}])],
        )

        resultado = service.finalizar(supabase, TEST_USER_ID, ATENDIMENTO_ID, self._body_finalizar(quantidade=2.0))

        assert supabase.rpc.call_count == 1
        nome_rpc, params = supabase.rpc.call_args[0]
        assert nome_rpc == "ajustar_estoque"
        assert params["p_item_id"] == ITEM_A
        assert params["p_delta"] == -2.0
        assert params["p_user_id"] == TEST_USER_ID
        assert params["p_permitir_negativo"] is False
        assert resultado["id"] == ATENDIMENTO_ID

    def test_finalizar_corrida_no_segundo_item_desfaz_o_primeiro(self):
        """
        Dois itens: o primeiro decrementa com sucesso pelo RPC, o segundo
        perde a corrida (RPC devolve None). O primeiro item precisa ser
        desfeito (RPC de estorno com permitir_negativo=True) antes do 409
        subir — nunca deixar baixa parcial gravada.
        """
        body = FinalizarBodyIn(
            materiais=[
                MaterialEntradaIn(item_estoque_id=ITEM_A, quantidade=1.0),
                MaterialEntradaIn(item_estoque_id=ITEM_B, quantidade=1.0),
            ],
            confirmar_estoque_insuficiente=False,
        )
        supabase = _fake_supabase(
            table_data={
                "atendimentos": [MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "agendado"}])],
                "estoque_itens": [
                    MagicMock(data=[
                        self._item_estoque(ITEM_A, quantidade_atual=10.0),
                        self._item_estoque(ITEM_B, quantidade_atual=10.0),
                    ]),
                    MagicMock(data=[{"quantidade_atual": 0.0}]),  # re-consulta do item B após a corrida
                ],
            },
            rpc_data=[
                MagicMock(data=[{"id": ITEM_A, "quantidade_atual": 9.0}]),  # decremento do item A: ok
                MagicMock(data=None),  # decremento do item B: trava disparou (corrida)
                MagicMock(data=[{"id": ITEM_A, "quantidade_atual": 10.0}]),  # rollback do item A
            ],
        )

        with pytest.raises(HTTPException) as exc:
            service.finalizar(supabase, TEST_USER_ID, ATENDIMENTO_ID, body)

        assert exc.value.status_code == 409
        assert exc.value.detail["codigo"] == "ESTOQUE_INSUFICIENTE"
        assert supabase.rpc.call_count == 3
        # a 3ª chamada é o rollback: item A, delta positivo (devolve), permitir_negativo=True
        _, params_rollback = supabase.rpc.call_args_list[2][0]
        assert params_rollback["p_item_id"] == ITEM_A
        assert params_rollback["p_delta"] == 1.0
        assert params_rollback["p_permitir_negativo"] is True

    def test_finalizar_confirmado_permite_negativo(self):
        supabase = _fake_supabase(
            table_data={
                "atendimentos": [
                    MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "agendado"}]),
                    MagicMock(data=[]),
                    MagicMock(data=[{
                        "id": ATENDIMENTO_ID, "nome_cliente": "Cliente Teste", "telefone_cliente": None,
                        "data": "2026-01-01T10:00:00-03:00", "status": "finalizado",
                    }]),
                ],
                "estoque_itens": [MagicMock(data=[self._item_estoque(ITEM_A, quantidade_atual=1.0)])],
                "atendimento_insumos": [MagicMock(data=[]), MagicMock(data=[])],
                "estoque_movimentacoes": [MagicMock(data=[])],
                "alertas": [MagicMock(data=[])],
                "atendimento_servicos": [
                    MagicMock(data=[]),
                    MagicMock(data=[{"servico_id": None, "nome_servico": "Corte", "preco_snapshot": 50.0}]),
                ],
            },
            rpc_data=[MagicMock(data=[{"id": ITEM_A, "quantidade_atual": -1.0}])],
        )

        service.finalizar(supabase, TEST_USER_ID, ATENDIMENTO_ID, self._body_finalizar(quantidade=2.0, confirmar=True))

        _, params = supabase.rpc.call_args_list[0][0]
        assert params["p_permitir_negativo"] is True


class TestCancelar:
    def test_cancelar_ja_cancelado_409(self):
        supabase = _fake_supabase({
            "atendimentos": [MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "cancelado"}])],
        })
        with pytest.raises(HTTPException) as exc:
            service.cancelar(supabase, TEST_USER_ID, ATENDIMENTO_ID)
        assert exc.value.status_code == 409

    def test_cancelar_finalizado_estorna_via_rpc_atomico(self):
        supabase = _fake_supabase(
            table_data={
                "atendimentos": [
                    MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "finalizado"}]),  # _buscar_atendimento
                    MagicMock(data=[]),  # update status cancelado
                    MagicMock(data=[{
                        "id": ATENDIMENTO_ID, "nome_cliente": "Cliente Teste", "telefone_cliente": None,
                        "data": "2026-01-01T10:00:00-03:00", "status": "cancelado",
                    }]),  # obter()'s _buscar_atendimento
                ],
                "estoque_movimentacoes": [
                    MagicMock(data=[{"item_id": ITEM_A, "quantidade": 2.0}]),  # select saídas
                    MagicMock(data=[]),  # insert ajuste
                ],
                "atendimento_servicos": [MagicMock(data=[])],
                "atendimento_insumos": [MagicMock(data=[])],
            },
            rpc_data=[MagicMock(data=[{"id": ITEM_A, "quantidade_atual": 12.0}])],
        )

        service.cancelar(supabase, TEST_USER_ID, ATENDIMENTO_ID)

        assert supabase.rpc.call_count == 1
        _, params = supabase.rpc.call_args_list[0][0]
        assert params["p_item_id"] == ITEM_A
        assert params["p_delta"] == 2.0
        assert params["p_permitir_negativo"] is True

    def test_cancelar_agendado_nao_mexe_em_estoque(self):
        supabase = _fake_supabase({
            "atendimentos": [
                MagicMock(data=[{"id": ATENDIMENTO_ID, "status": "agendado"}]),
                MagicMock(data=[]),
                MagicMock(data=[{
                    "id": ATENDIMENTO_ID, "nome_cliente": "Cliente Teste", "telefone_cliente": None,
                    "data": "2026-01-01T10:00:00-03:00", "status": "cancelado",
                }]),
            ],
            "atendimento_servicos": [MagicMock(data=[])],
            "atendimento_insumos": [MagicMock(data=[])],
        })

        service.cancelar(supabase, TEST_USER_ID, ATENDIMENTO_ID)

        supabase.rpc.assert_not_called()
