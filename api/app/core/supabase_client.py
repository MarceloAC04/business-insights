import httpx
from postgrest import SyncPostgrestClient
from supabase import Client
from supabase.lib.client_options import SyncClientOptions
from app.core.config import get_settings


class ClientePostgrestHttp1(SyncPostgrestClient):
    """Cliente REST sem HTTP/2, mais estável para o proxy do Supabase."""

    def create_session(
        self,
        base_url: str,
        headers: dict[str, str],
        timeout: int | float | httpx.Timeout,
        verify: bool = True,
    ) -> httpx.Client:
        return httpx.Client(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            verify=verify,
            follow_redirects=True,
            http2=False,
        )


class ClienteSupabaseHttp1(Client):
    """Supabase cujo PostgREST usa HTTP/1.1 em vez do padrão HTTP/2 da SDK."""

    @staticmethod
    def _init_postgrest_client(
        rest_url: str,
        headers: dict[str, str],
        schema: str,
        timeout: int | float | httpx.Timeout,
        verify: bool = True,
        proxy: str | None = None,
        http_client: httpx.Client | None = None,
    ) -> SyncPostgrestClient:
        client = http_client or httpx.Client(
            base_url=rest_url,
            headers=headers,
            timeout=timeout,
            verify=verify,
            proxy=proxy,
            follow_redirects=True,
            http2=False,
        )
        return ClientePostgrestHttp1(
            rest_url,
            headers=headers,
            schema=schema,
            timeout=timeout,
            verify=verify,
            proxy=proxy,
            http_client=client,
        )


def _criar_cliente(supabase_url: str, supabase_key: str) -> Client:
    # A SDK configura o PostgREST com HTTP/2 internamente. Na rede local ele
    # encerra streams sob várias requisições simultâneas, produzindo 500
    # intermitente como `RemoteProtocolError: Server disconnected`.
    return ClienteSupabaseHttp1(
        supabase_url,
        supabase_key,
        options=SyncClientOptions(auto_refresh_token=False, persist_session=False),
    )


def get_supabase() -> Client:
    """
    Cliente Supabase novo por requisição usando a service key. A service key
    bypassa o RLS — use apenas para operação administrativa/de servidor
    (consultas com a autorização derivada do JWT já validado, não do Supabase
    Auth).

    NUNCA chame `.auth.sign_in_with_password` / `.refresh_session` /
    `.sign_out` neste cliente: autenticação é sempre feita por
    `get_supabase_auth()`, mantendo o cliente administrativo com a service
    key durante toda a requisição.
    """
    cfg = get_settings()
    return _criar_cliente(cfg.supabase_url, cfg.supabase_service_key)


def get_supabase_auth() -> Client:
    """
    Cliente novo a cada chamada, com a chave `anon` — é o que `login`,
    `refresh` e `logout` devem usar para `sign_in_with_password` /
    `refresh_session` / `sign_out`. Descartável de propósito: não é cacheado
    porque cada um desses três métodos muta o header `Authorization` do
    cliente que os chama (ver aviso em `get_supabase`), e aqui isso não tem
    efeito colateral nenhum — o cliente morre no fim da requisição.
    """
    cfg = get_settings()
    return _criar_cliente(cfg.supabase_url, cfg.supabase_anon_key)


def get_supabase_publico() -> Client:
    """
    Cliente novo a cada chamada, com a chave `anon` — para o módulo
    `agendamento_publico` (`routers/agendamento_publico.py`), o único que
    atende requisição sem sessão. As 3 RPCs desse módulo já são `security
    definer` e não dependem de `auth.uid()` (resolvem o salão pelo `slug`),
    então funcionam idênticas com a chave `anon` ou com a `service_role` —
    O cliente é descartável por requisição. Assim, chamadas públicas
    concorrentes não compartilham o mesmo transporte síncrono e uma falha de
    rede não contamina a requisição seguinte.
    """
    cfg = get_settings()
    return _criar_cliente(cfg.supabase_url, cfg.supabase_anon_key)


from typing import Any, cast


def rows(resp_data: Any) -> list[dict[str, Any]]:
    """Converte retorno do Supabase em list[dict[str, Any]] para tipagem estrita."""
    if not resp_data:
        return []
    if isinstance(resp_data, list):
        return cast(list[dict[str, Any]], resp_data)
    if isinstance(resp_data, dict):
        return [cast(dict[str, Any], resp_data)]
    return []


def row(resp_data: Any) -> dict[str, Any]:
    """Converte retorno unitário do Supabase em dict[str, Any]."""
    if not resp_data:
        return {}
    if isinstance(resp_data, list):
        return cast(dict[str, Any], resp_data[0]) if resp_data else {}
    if isinstance(resp_data, dict):
        return cast(dict[str, Any], resp_data)
    return {}

