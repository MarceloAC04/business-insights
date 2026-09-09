"""Testes do envio best-effort de alertas por Web Push."""

from unittest.mock import MagicMock

from app.core.config import get_settings
from app.services import push_service


def _consulta(data):
    consulta = MagicMock()
    consulta.select.return_value = consulta
    consulta.eq.return_value = consulta
    consulta.limit.return_value = consulta
    consulta.execute.return_value = MagicMock(data=data)
    return consulta


def test_notifica_alerta_para_dispositivos_web_ativos(monkeypatch):
    user_id = "user-1"
    assinatura = {
        "endpoint": "https://push.example/subscription",
        "keys": {"p256dh": "chave-publica", "auth": "chave-auth"},
    }
    preferencias = _consulta([{"canal_push": True, "tipos_silenciados": []}])
    dispositivos = _consulta(
        [{"id": "device-1", "assinatura_web_push": assinatura}]
    )
    marcado = MagicMock()
    marcado.update.return_value = marcado
    marcado.eq.return_value = marcado
    marcado.is_.return_value = marcado
    marcado.execute.return_value = MagicMock(data=[])
    supabase = MagicMock()
    supabase.table.side_effect = [preferencias, dispositivos, marcado]

    settings = get_settings()
    monkeypatch.setattr(settings, "web_push_vapid_public_key", "publica")
    monkeypatch.setattr(settings, "web_push_vapid_private_key", "privada")
    monkeypatch.setattr(settings, "web_push_vapid_subject", "mailto:test@example.com")
    enviar = MagicMock()
    monkeypatch.setattr(push_service, "webpush", enviar)

    push_service.notificar_alerta_novo(
        supabase,
        user_id,
        {
            "tipo": "estoque_baixo",
            "titulo": "Estoque baixo",
            "mensagem": "Restam 2 unidades.",
            "chave_dedupe": "estoque_condicao:item-1",
        },
    )

    enviar.assert_called_once()
    assert enviar.call_args.kwargs["subscription_info"] == assinatura
    assert '"title": "Estoque baixo"' in enviar.call_args.kwargs["data"]
    marcado.update.assert_called_once()


def test_nao_notifica_tipo_silenciado(monkeypatch):
    preferencias = _consulta(
        [{"canal_push": True, "tipos_silenciados": ["estoque_baixo"]}]
    )
    supabase = MagicMock()
    supabase.table.return_value = preferencias
    enviar = MagicMock()
    monkeypatch.setattr(push_service, "webpush", enviar)

    settings = get_settings()
    monkeypatch.setattr(settings, "web_push_vapid_public_key", "publica")
    monkeypatch.setattr(settings, "web_push_vapid_private_key", "privada")
    monkeypatch.setattr(settings, "web_push_vapid_subject", "mailto:test@example.com")

    push_service.notificar_alerta_novo(
        supabase,
        "user-1",
        {"tipo": "estoque_baixo", "titulo": "Baixo", "mensagem": "Baixo"},
    )

    enviar.assert_not_called()
