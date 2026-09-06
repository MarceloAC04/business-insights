"""
Regras do agendamento público (endpoints-backend.md §10, lote L8).

Único módulo sem Authorization: o `slug` na URL identifica o salão e não é
secreto (a ideia é ser compartilhável). Por isso nenhuma consulta aqui pode
vazar dado sensível do módulo `perfil` (telefone, custo fixo, estoque) — só
nome, foto, serviços e preços, que já são públicos num cartão de visita.

As 3 operações delegam para as RPCs `security definer` de
`database/migrations/005_agendamento_publico_rpc.sql` — exatamente as mesmas
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

from postgrest.exceptions import APIError
from fastapi import HTTPException
from supabase import Client


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
    return resp.data
