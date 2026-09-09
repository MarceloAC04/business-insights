import json
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services import realtime_service


def _config(url: str = "", token: str = "") -> SimpleNamespace:
    return SimpleNamespace(upstash_redis_rest_url=url, upstash_redis_rest_token=token)


def test_mensagem_upstash_filtra_apenas_publicacao():
    assert realtime_service._mensagem_upstash("data: subscribe,canal,1") is None
    assert realtime_service._mensagem_upstash('data: message,canal,{"tipo":"alteracao"}') == (
        '{"tipo":"alteracao"}'
    )


def test_sinalizar_alertas_publica_sem_dados_do_alerta(monkeypatch):
    resposta = MagicMock()
    resposta.json.return_value = {"result": 1}
    monkeypatch.setattr(realtime_service, "get_settings", lambda: _config("https://redis.test", "token"))
    post = MagicMock(return_value=resposta)
    monkeypatch.setattr(realtime_service.httpx, "post", post)

    assert realtime_service.sinalizar_alertas("usuario-1") is True

    comando = post.call_args.kwargs["json"]
    assert comando[0] == "PUBLISH"
    assert comando[1] == "glowapp:alertas:usuario-1"
    assert json.loads(comando[2]) == {"tipo": "alteracao"}


def test_sinalizar_alertas_e_noop_sem_credenciais(monkeypatch):
    monkeypatch.setattr(realtime_service, "get_settings", lambda: _config())
    post = MagicMock()
    monkeypatch.setattr(realtime_service.httpx, "post", post)

    assert realtime_service.sinalizar_alertas("usuario-1") is False
    post.assert_not_called()
