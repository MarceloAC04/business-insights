"""Router: /kits (endpoints-backend.md §6, 6 operações)."""

from fastapi import APIRouter, Depends
from supabase import Client

from app.core.security import usuario_atual
from app.core.supabase_client import get_supabase
from app.schemas.envelope import ResponseModel, sucesso
from app.schemas.kits import KitIn, KitOut, KitPatchIn, KitsListaOut, MontarKitIn, VenderKitIn
from app.services import kits_service as service

router = APIRouter(prefix="/kits", tags=["Kits"])


@router.get("", response_model=ResponseModel[KitsListaOut], summary="Lista kits de revenda")
def listar_kits(
    user_id: str = Depends(usuario_atual),
    supabase: Client = Depends(get_supabase),
):
    resultado = service.listar(supabase, user_id)
    return sucesso(resultado, total=len(resultado["kits"]))


@router.post("", response_model=ResponseModel[KitOut], summary="Cadastra kit de revenda")
def criar_kit(
    body: KitIn,
    user_id: str = Depends(usuario_atual),
    supabase: Client = Depends(get_supabase),
):
    resultado = service.criar(supabase, user_id, body)
    return sucesso(resultado)


@router.patch("/{kit_id}", response_model=ResponseModel[KitOut], summary="Edita kit de revenda")
def editar_kit(
    kit_id: str,
    body: KitPatchIn,
    user_id: str = Depends(usuario_atual),
    supabase: Client = Depends(get_supabase),
):
    resultado = service.editar(supabase, user_id, kit_id, body)
    return sucesso(resultado)


@router.delete("/{kit_id}", response_model=ResponseModel[None], summary="Exclui kit (soft delete se já usado)")
def excluir_kit(
    kit_id: str,
    user_id: str = Depends(usuario_atual),
    supabase: Client = Depends(get_supabase),
):
    service.excluir(supabase, user_id, kit_id)
    return sucesso(None)


@router.post(
    "/{kit_id}/montar",
    response_model=ResponseModel[KitOut],
    summary="Monta kit a partir do estoque de insumos (A7)",
)
def montar_kit(
    kit_id: str,
    body: MontarKitIn,
    user_id: str = Depends(usuario_atual),
    supabase: Client = Depends(get_supabase),
):
    resultado = service.montar(supabase, user_id, kit_id, body)
    return sucesso(resultado)


@router.post(
    "/{kit_id}/vender",
    response_model=ResponseModel[KitOut],
    summary="Vende kit montado (A7 — sem segunda passada)",
)
def vender_kit(
    kit_id: str,
    body: VenderKitIn,
    user_id: str = Depends(usuario_atual),
    supabase: Client = Depends(get_supabase),
):
    resultado = service.vender(supabase, user_id, kit_id, body)
    return sucesso(resultado)
