"""
Regras do agendamento público (endpoints-backend.md §10, lote L8).

Único módulo sem Authorization: o `slug` na URL identifica o salão e não é
secreto (a ideia é ser compartilhável). Por isso nenhuma consulta aqui pode
vazar dado sensível do módulo `perfil` (custos, estoque ou credenciais) — só
os contatos e dados de apresentação que a profissional escolheu publicar,
além de expediente, serviços e preços.

As 3 operações delegam para as RPCs `security definer` de
`database/migrations/005_agendamento_publico_rpc.sql` (estendida pela 010) — exatamente as mesmas
que o `salao_web` chama direto no Supabase (branch `feat/react-supabase`,
`lib/api/agendamento-publico.ts`). Não são reimplementadas aqui em cima das
tabelas cruas: a versão anterior deste arquivo fazia isso e tinha uma janela
de corrida conhecida e documentada entre a checagem de horário livre e o
insert do atendimento (dois clientes públicos podiam ver o mesmo horário como
livre e gravar os dois). A RPC `agendamento_publico_agendar` fecha essa janela
com `pg_advisory_xact_lock` por salão, serializando tentativas concorrentes e
revalidando a agenda depois de travar — algo que duas chamadas independentes
do lado do backend (um `select` seguido de um `insert`) não conseguem
reproduzir sem o mesmo tipo de trava no banco. Nenhuma das 3 RPCs depende de
`auth.uid()` (leem o salão a partir do `p_slug`), então funcionam
identicamente chamadas pelo `service_role` daqui ou pela `anon key` do
frontend.
"""

from datetime import datetime
import logging

from postgrest.exceptions import APIError
from fastapi import HTTPException
from supabase import Client

from app.core.supabase_client import row
from app.services import push_service


logger = logging.getLogger(__name__)


def _erro_rpc(exc: APIError) -> HTTPException:
    """
    Traduz o texto de `raise exception '...'` das RPCs para o formato de erro
    do backend — mesmo mapeamento por substring que `erroSupabase()` faz em
    `agendamento-publico.ts` (frontend), porque é a mesma RPC gerando a mesma
    mensagem nos dois casos.
    """
    mensagem = getattr(exc, "message", None) or str(exc)
    if "SALAO_NAO_ENCONTRADO" in mensagem:
        return HTTPException(
            status_code=404,
            detail={
                "codigo": "RECURSO_NAO_ENCONTRADO",
                "mensagem": "Esse link de agendamento não existe ou não está mais ativo.",
            },
        )
    if "SERVICO_INVALIDO" in mensagem or "VALIDACAO_INVALIDA" in mensagem:
        return HTTPException(
            status_code=422,
            detail={"codigo": "VALIDACAO_INVALIDA", "mensagem": "Confira os serviços e dados informados."},
        )
    if "HORARIO_INDISPONIVEL" in mensagem:
        return HTTPException(
            status_code=409,
            detail={
                "codigo": "HORARIO_INDISPONIVEL",
                "mensagem": "Esse horário acabou de ser preenchido. Escolha outro.",
            },
        )
    return HTTPException(status_code=500, detail={"codigo": None, "mensagem": mensagem})


def obter_pagina(supabase: Client, slug: str) -> dict:
    """Devolve `{"salao": {...}, "servicos": [...]}` (formato já pronto para `AgendamentoPublicoOut`)."""
    try:
        resp = supabase.rpc("agendamento_publico_pagina", {"p_slug": slug}).execute()
    except APIError as exc:
        raise _erro_rpc(exc)
    return resp.data


def calcular_horarios_disponiveis(supabase: Client, slug: str, data_str: str, servico_ids: list[str]) -> dict:
    """Devolve `{"duracao_total_minutos": int, "horarios": [...]}`."""
    try:
        resp = supabase.rpc(
            "agendamento_publico_horarios",
            {"p_slug": slug, "p_data": data_str, "p_servico_ids": servico_ids},
        ).execute()
    except APIError as exc:
        raise _erro_rpc(exc)
    return resp.data


def criar_agendamento(
    supabase: Client,
    slug: str,
    cliente_nome: str,
    cliente_telefone: str,
    data_hora: datetime,
    servico_ids: list[str],
    supabase_push: Client | None = None,
) -> dict:
    """Devolve `{"id", "data", "status", "servicos": [{"servico_id", "nome", "preco"}]}`."""
    try:
        resp = supabase.rpc(
            "agendamento_publico_agendar",
            {
                "p_slug": slug,
                "p_cliente_nome": cliente_nome,
                "p_cliente_telefone": cliente_telefone,
                "p_data": data_hora.isoformat(),
                "p_servico_ids": servico_ids,
            },
        ).execute()
    except APIError as exc:
        raise _erro_rpc(exc)
    resultado = resp.data
    if supabase_push is not None:
        try:
            perfil = row(
                supabase_push.table("perfil_salao")
                .select("user_id")
                .eq("slug_agendamento", slug)
                .limit(1)
                .execute()
                .data
            )
            user_id = perfil.get("user_id")
            if user_id:
                push_service.notificar_alerta_novo(
                    supabase=supabase_push,
                    user_id=str(user_id),
                    alerta={
                        "tipo": "agendamento_publico_novo",
                        "severidade": "info",
                        "titulo": "Novo agendamento pelo link",
                        "mensagem": f"{cliente_nome.strip()} marcou horário pelo link de agendamento",
                        "referencia_tipo": "atendimento",
                        "referencia_id": resultado["id"],
                        "chave_dedupe": f"agendamento_publico_novo:{resultado['id']}",
                    },
                )
        except Exception as exc:  # o agendamento já foi confirmado; push é best-effort
            logger.warning(
                "Falha ao preparar push de agendamento público: tipo=%s",
                type(exc).__name__,
            )
    return resultado
