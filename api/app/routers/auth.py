"""
Router: /auth

Bloqueia todo o resto (L0.4 em 00-ENTREGA-BACKEND.md): sem login o app não
passa da tela inicial.

Implementação: delega a autenticação em si para o Supabase Auth (GoTrue),
via `supabase.auth.sign_in_with_password` / `refresh_session` / `sign_out`.
O FastAPI não guarda senha nem emite JWT próprio — apenas repassa o
token/refresh_token que o Supabase já emite e assina com o mesmo
SUPABASE_JWT_SECRET que `usuario_atual` valida em todo outro endpoint.
Isso evita duplicar uma tabela de refresh tokens e uma lógica de expiração
que o Supabase já resolve.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from supabase import Client
from supabase_auth.errors import AuthApiError, AuthInvalidCredentialsError

from app.core.supabase_client import get_supabase, get_supabase_auth, row, rows
from app.core.security import usuario_atual, token_atual
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    SessaoOut,
    EuOut,
    UsuarioOut,
    SalaoOut,
)
from app.schemas.envelope import sucesso, ResponseModel

router = APIRouter(prefix="/auth", tags=["Auth"])
logger = logging.getLogger(__name__)

_CODIGO_CREDENCIAIS_INVALIDAS = "AUTH_CREDENCIAIS_INVALIDAS"
_CODIGO_SERVICO_INDISPONIVEL = "AUTH_SERVICO_INDISPONIVEL"


def _e_erro_de_credencial(erro: Exception) -> bool:
    """Reconhece somente a resposta de credencial recusada pelo Auth."""
    if isinstance(erro, AuthInvalidCredentialsError):
        return True

    if not isinstance(erro, AuthApiError):
        return False

    if str(erro.code or "").lower() == "invalid_credentials":
        return True

    # Compatibilidade com versões do Supabase que não enviavam `code`.
    mensagem = str(erro).strip().lower()
    return erro.status in (400, 401) and mensagem in {
        "invalid login credentials",
        "invalid login",
    }


def _erro_do_login(erro: Exception) -> HTTPException:
    if _e_erro_de_credencial(erro):
        return HTTPException(
            status_code=401,
            detail={
                "codigo": _CODIGO_CREDENCIAIS_INVALIDAS,
                "mensagem": "E-mail ou senha incorretos",
            },
        )

    # Não expõe a mensagem do provedor nem transforma indisponibilidade em
    # erro de senha. O tipo/status ficam no log para diagnóstico local.
    logger.warning(
        "Falha no provedor de autenticação durante login: tipo=%s status=%s",
        type(erro).__name__,
        getattr(erro, "status", None),
    )
    return HTTPException(
        status_code=503,
        detail={
            "codigo": _CODIGO_SERVICO_INDISPONIVEL,
            "mensagem": "O serviço de login está indisponível no momento",
        },
    )


def _buscar_salao(supabase: Client, user_id: str) -> tuple[SalaoOut, str]:
    resp = (
        supabase.table("perfil_salao")
        .select("id, nome_salao, nome_proprietaria, foto_url")
        .eq("user_id", user_id)
        .single()
        .execute()
    )
    linha = row(resp.data)
    return (
        SalaoOut(
            id=linha.get("id", user_id),
            nome=linha.get("nome_salao", "Meu Salão"),
            foto_url=linha.get("foto_url"),
        ),
        str(linha.get("nome_proprietaria") or "").strip(),
    )


def _nome_de_exibicao(user, nome_proprietaria: str) -> str:
    """Escolhe um nome humano para a saudação, jamais o e-mail da conta."""
    metadata = getattr(user, "user_metadata", None) or {}
    nome_metadata = metadata.get("nome", "") if isinstance(metadata, dict) else ""

    for nome in (nome_metadata, nome_proprietaria):
        nome_limpo = str(nome or "").strip()
        if nome_limpo and "@" not in nome_limpo:
            return nome_limpo
    return ""


def _montar_sessao(supabase: Client, auth_response) -> SessaoOut:
    session = auth_response.session
    user = auth_response.user
    if session is None or user is None:
        raise HTTPException(
            status_code=401,
            detail={"codigo": "AUTH_CREDENCIAIS_INVALIDAS", "mensagem": "E-mail ou senha incorretos"},
        )

    salao, nome_proprietaria = _buscar_salao(supabase, user.id)
    usuario = UsuarioOut(
        id=user.id,
        nome=_nome_de_exibicao(user, nome_proprietaria),
        email=user.email or "",
    )

    return SessaoOut(
        token=session.access_token,
        refresh_token=session.refresh_token,
        expira_em=session.expires_in,
        usuario=usuario,
        salao=salao,
    )


@router.post(
    "/login",
    response_model=ResponseModel[SessaoOut],
    summary="Autentica com e-mail e senha",
)
def login(
    dados: LoginRequest,
    supabase: Client = Depends(get_supabase),
    supabase_auth: Client = Depends(get_supabase_auth),
):
    try:
        auth_response = supabase_auth.auth.sign_in_with_password(
            {"email": dados.email, "password": dados.senha}
        )
    except Exception as erro:
        raise _erro_do_login(erro) from erro

    try:
        sessao = _montar_sessao(supabase, auth_response)
    except HTTPException:
        raise
    except Exception as erro:
        logger.warning(
            "Falha ao carregar os dados do salão após login: tipo=%s",
            type(erro).__name__,
        )
        raise _erro_do_login(erro) from erro
    return sucesso(sessao.model_dump())


@router.post(
    "/refresh",
    response_model=ResponseModel[SessaoOut],
    summary="Renova o token a partir do refresh_token",
)
def refresh(
    dados: RefreshRequest,
    supabase: Client = Depends(get_supabase),
    supabase_auth: Client = Depends(get_supabase_auth),
):
    try:
        auth_response = supabase_auth.auth.refresh_session(dados.refresh_token)
    except Exception:
        raise HTTPException(
            status_code=401,
            detail={"codigo": "AUTH_REFRESH_INVALIDO", "mensagem": "Sessão expirada, faça login novamente"},
        )

    sessao = _montar_sessao(supabase, auth_response)
    return sucesso(sessao.model_dump())


@router.post(
    "/logout",
    response_model=ResponseModel[None],
    summary="Invalida a sessão corrente",
)
def logout(
    token: str = Depends(token_atual),
    supabase_auth: Client = Depends(get_supabase_auth),
):
    # `supabase_auth.auth.sign_out()` (sem argumento) só revoga sessão quando
    # o PRÓPRIO cliente que a chama tem uma sessão ativa (via `set_session`);
    # `get_supabase_auth()` devolve um cliente novo a cada requisição, sem
    # nenhuma sessão setada — `sign_out()` nele é um no-op silencioso (não
    # lança erro, só não revoga nada). `auth.admin.sign_out(jwt, scope)` faz a
    # chamada direto com o token que veio no header, sem depender de estado
    # de sessão no cliente — é o que revoga de verdade.
    try:
        supabase_auth.auth.admin.sign_out(token, "global")
    except Exception:
        # Logout é best-effort — mesmo se a revogação no Supabase falhar,
        # o app já descarta o token localmente.
        pass
    return sucesso(None, total=0)


@router.get(
    "/eu",
    response_model=ResponseModel[EuOut],
    summary="Dados da sessão corrente (usuária + salão)",
)
def eu(user_id: str = Depends(usuario_atual), supabase: Client = Depends(get_supabase)):
    resp = supabase.auth.admin.get_user_by_id(user_id)
    user = resp.user if hasattr(resp, "user") else resp

    salao, nome_proprietaria = _buscar_salao(supabase, user_id)
    usuario = UsuarioOut(
        id=user_id,
        nome=_nome_de_exibicao(user, nome_proprietaria),
        email=getattr(user, "email", "") or "",
    )

    return sucesso(EuOut(usuario=usuario, salao=salao).model_dump())
