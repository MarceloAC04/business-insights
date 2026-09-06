"""
Router: /agendamento-publico (endpoints-backend.md §10, lote L8)

Único módulo sem Authorization — ver o aviso no topo de
services/agendamento_publico_service.py sobre o que pode e não pode
vazar aqui.
"""

from datetime import date

from fastapi import APIRouter, Depends, Query
from supabase import Client

from app.core.supabase_client import get_supabase
from app.schemas.agendamento_publico import (
    AgendamentoCriadoOut,
    AgendamentoPublicoOut,
    AgendarRequest,
    HorariosDisponiveisOut,
    SalaoPublicoOut,
    ServicoAgendadoOut,
    ServicoPublicoOut,
)
from app.schemas.envelope import ResponseModel, sucesso
from app.services import agendamento_publico_service as service

router = APIRouter(prefix="/agendamento-publico", tags=["Agendamento público"])


@router.get(
    "/{slug}",
    response_model=ResponseModel[AgendamentoPublicoOut],
    summary="Dados públicos do salão para montar a tela de agendar",
)
def obter_pagina_agendamento(slug: str, supabase: Client = Depends(get_supabase)):
    dados = service.obter_pagina(supabase, slug)
    payload = AgendamentoPublicoOut(
        salao=SalaoPublicoOut(**dados["salao"]),
        servicos=[ServicoPublicoOut(**s) for s in dados["servicos"]],
    )
    return sucesso(payload.model_dump())


@router.get(
    "/{slug}/horarios-disponiveis",
    response_model=ResponseModel[HorariosDisponiveisOut],
    summary="Horários livres num dia, para os serviços escolhidos",
)
def obter_horarios_disponiveis(
    slug: str,
    data: date = Query(...),
    servico_ids: str = Query(..., description="uuids separados por vírgula"),
    supabase: Client = Depends(get_supabase),
):
    ids = [s.strip() for s in servico_ids.split(",") if s.strip()]
    dados = service.calcular_horarios_disponiveis(supabase, slug, data.isoformat(), ids)
    payload = HorariosDisponiveisOut(**dados)
    return sucesso(payload.model_dump())


@router.post(
    "/{slug}/agendar",
    response_model=ResponseModel[AgendamentoCriadoOut],
    summary="Cria o agendamento direto como confirmado",
)
def agendar(slug: str, dados: AgendarRequest, supabase: Client = Depends(get_supabase)):
    resultado = service.criar_agendamento(
        supabase,
        slug=slug,
        cliente_nome=dados.cliente_nome,
        cliente_telefone=dados.cliente_telefone,
        data_hora=dados.data,
        servico_ids=[s.servico_id for s in dados.servicos],
    )
    payload = AgendamentoCriadoOut(
        id=resultado["id"],
        data=resultado["data"],
        status=resultado["status"],
        servicos=[ServicoAgendadoOut(**s) for s in resultado["servicos"]],
    )
    return sucesso(payload.model_dump(mode="json"))
