"""Envio de alertas por Web Push para navegadores autorizados."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from pywebpush import WebPushException, webpush
from supabase import Client

from app.core.config import get_settings
from app.core.supabase_client import rows
from app.services import realtime_service

logger = logging.getLogger(__name__)


def _obter_destinatarios(
    supabase: Client, user_id: str
) -> tuple[list[dict[str, Any]], set[str]] | None:
    pref_linhas = rows(
        supabase.table("alerta_preferencias")
        .select("canal_push, tipos_silenciados")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
        .data
    )
    preferencia = pref_linhas[0] if pref_linhas else {}
    if not bool(preferencia.get("canal_push", True)):
        return None

    dispositivos = rows(
        supabase.table("dispositivos")
        .select("id, assinatura_web_push")
        .eq("user_id", user_id)
        .eq("plataforma", "web")
        .eq("ativo", True)
        .execute()
        .data
    )
    return dispositivos, set(preferencia.get("tipos_silenciados") or [])


def _enviar_alerta(
    supabase: Client,
    user_id: str,
    alerta: dict[str, Any],
    dispositivos: list[dict[str, Any]],
    cfg: Any,
) -> bool:
    payload = json.dumps(
        {
            "title": alerta.get("titulo") or "Novo alerta",
            "body": alerta.get("mensagem") or "Você tem um novo alerta no GlowApp.",
            "tag": alerta.get("chave_dedupe") or alerta.get("tipo") or "glowapp-alerta",
            "data": {
                "url": "/alertas",
                "tipo": alerta.get("tipo"),
                "referencia_tipo": alerta.get("referencia_tipo"),
                "referencia_id": alerta.get("referencia_id"),
            },
        }
    )
    enviado = False
    for dispositivo in dispositivos:
        assinatura = dispositivo.get("assinatura_web_push")
        if not isinstance(assinatura, dict):
            continue
        try:
            webpush(
                subscription_info=assinatura,
                data=payload,
                vapid_private_key=cfg.web_push_vapid_private_key,
                vapid_claims={"sub": cfg.web_push_vapid_subject},
                ttl=86400,
            )
            enviado = True
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                supabase.table("dispositivos").update({"ativo": False}).eq(
                    "id", dispositivo["id"]
                ).eq("user_id", user_id).execute()
            logger.warning("Falha ao enviar Web Push: status=%s", status)
        except Exception as exc:  # o alerta já foi gravado; push é best-effort
            logger.warning("Falha ao enviar Web Push: tipo=%s", type(exc).__name__)
    return enviado


def _marcar_push_enviado(supabase: Client, user_id: str, alerta: dict[str, Any]) -> None:
    query = supabase.table("alertas").update(
        {"push_enviado_em": datetime.now(timezone.utc).isoformat()}
    ).eq("user_id", user_id)
    if alerta.get("id"):
        query = query.eq("id", alerta["id"])
    elif alerta.get("chave_dedupe"):
        query = query.eq("chave_dedupe", alerta["chave_dedupe"]).is_(
            "resolvido_em", "null"
        )
    else:
        return
    query.execute()


def notificar_alerta_novo(supabase: Client, user_id: str, alerta: dict[str, Any]) -> bool:
    """Envia um alerta recém-criado sem deixar o fluxo principal depender do push."""
    # O evento in-app é independente do Web Push: a usuária pode estar com o
    # app aberto mesmo sem ter autorizado notificações do navegador.
    realtime_service.sinalizar_alertas(user_id)
    if alerta.get("push_enviado_em"):
        return False
    cfg = get_settings()
    if not (
        cfg.web_push_vapid_public_key
        and cfg.web_push_vapid_private_key
        and cfg.web_push_vapid_subject
    ):
        return False

    try:
        destinatarios = _obter_destinatarios(supabase, user_id)
        if destinatarios is None:
            return False
        dispositivos, silenciados = destinatarios
        if alerta.get("tipo") in silenciados:
            return False
        enviado = _enviar_alerta(supabase, user_id, alerta, dispositivos, cfg)
        if enviado:
            _marcar_push_enviado(supabase, user_id, alerta)
        return enviado
    except Exception as exc:
        # Um problema no push nunca pode desfazer um alerta já persistido.
        logger.warning("Push ignorado por falha de preparação: tipo=%s", type(exc).__name__)
        return False


def notificar_alertas_pendentes(
    supabase: Client, user_id: str, alertas: list[dict[str, Any]]
) -> None:
    """Entrega alertas inseridos por RPCs ou integrações antes de serem exibidos."""
    pendentes = [
        alerta
        for alerta in alertas
        # A coluna é o sinal de que a migration do controle de duplicidade já
        # está no banco. Sem ela, não tentamos consumir outras consultas nem
        # gerar notificações repetidas em ambientes ainda não migrados.
        if (
            "push_enviado_em" in alerta
            and alerta.get("push_enviado_em") is None
            and alerta.get("lido_em") is None
        )
    ]
    if not pendentes:
        return

    cfg = get_settings()
    if not (
        cfg.web_push_vapid_public_key
        and cfg.web_push_vapid_private_key
        and cfg.web_push_vapid_subject
    ):
        return
    try:
        destinatarios = _obter_destinatarios(supabase, user_id)
        if destinatarios is None:
            return
        dispositivos, silenciados = destinatarios
        for alerta in pendentes:
            if alerta.get("tipo") in silenciados:
                continue
            if _enviar_alerta(supabase, user_id, alerta, dispositivos, cfg):
                _marcar_push_enviado(supabase, user_id, alerta)
    except Exception as exc:
        logger.warning("Push pendente ignorado por falha de preparação: tipo=%s", type(exc).__name__)
