"""Canal de alterações de alertas via Pub/Sub do Upstash Redis."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from urllib.parse import quote

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_CANAL_PREFIXO = "glowapp:alertas:"
_TIMEOUT_PUBLICACAO = 0.8


def configurado() -> bool:
    cfg = get_settings()
    return bool(cfg.upstash_redis_rest_url and cfg.upstash_redis_rest_token)


def _canal(user_id: str) -> str:
    return f"{_CANAL_PREFIXO}{user_id}"


def _executar(comando: str, *argumentos: str) -> object | None:
    """Executa um comando REST sem deixar Redis derrubar o fluxo principal."""
    if not configurado():
        return None

    cfg = get_settings()
    try:
        resposta = httpx.post(
            cfg.upstash_redis_rest_url.rstrip("/"),
            json=[comando, *argumentos],
            headers={
                "Authorization": f"Bearer {cfg.upstash_redis_rest_token}",
                "Content-Type": "application/json",
            },
            timeout=_TIMEOUT_PUBLICACAO,
        )
        resposta.raise_for_status()
        payload = resposta.json()
        if isinstance(payload, dict) and payload.get("error"):
            raise RuntimeError(str(payload["error"]))
        return payload.get("result") if isinstance(payload, dict) else None
    except Exception as exc:  # Redis é um acelerador; Supabase continua sendo a verdade.
        logger.warning("Sinal realtime ignorado: tipo=%s", type(exc).__name__)
        return None


def sinalizar_alertas(user_id: str, tipo: str = "alteracao") -> bool:
    """Publica um sinal curto; nenhum dado sensível vai para o Redis."""
    mensagem = json.dumps({"tipo": tipo}, ensure_ascii=False, separators=(",", ":"))
    resultado = _executar("PUBLISH", _canal(user_id), mensagem)
    return resultado is not None


def _mensagem_upstash(linha: str) -> str | None:
    """Converte a linha SSE do Upstash em apenas o payload da mensagem."""
    if not linha.startswith("data:"):
        return None
    conteudo = linha.removeprefix("data:").strip()
    partes = conteudo.split(",", 2)
    if len(partes) != 3 or partes[0] != "message":
        return None
    return partes[2]


async def eventos_alertas(user_id: str) -> AsyncIterator[str]:
    """Repassa o Pub/Sub do Upstash em SSE autenticado para o navegador."""
    if not configurado():
        return

    cfg = get_settings()
    url = f"{cfg.upstash_redis_rest_url.rstrip('/')}/subscribe/{quote(_canal(user_id), safe='')}"
    try:
        async with httpx.AsyncClient(timeout=None) as cliente:
            async with cliente.stream(
                "POST",
                url,
                headers={
                    "Authorization": f"Bearer {cfg.upstash_redis_rest_token}",
                    "Accept": "text/event-stream",
                    "User-Agent": "GlowApp/alertas-realtime",
                },
            ) as resposta:
                resposta.raise_for_status()
                async for linha in resposta.aiter_lines():
                    mensagem = _mensagem_upstash(linha)
                    if mensagem is not None:
                        yield f"event: alertas\ndata: {mensagem}\n\n"
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # O cliente reconecta e o polling do React segue como fallback.
        logger.info("Canal realtime encerrado: tipo=%s", type(exc).__name__)
