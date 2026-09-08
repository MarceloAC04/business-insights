"""Serviço de alertas e dispositivos (endpoints-backend.md §9)."""

from datetime import datetime, timezone
from fastapi import HTTPException
from postgrest.exceptions import APIError
from supabase import Client

from app.core.supabase_client import row, rows
from app.schemas.alertas import (
    AlertaOut,
    AlertasResumo,
    AlertasListaOut,
    MarcarLidosIn,
    PreferenciasAlertaOut,
    PreferenciasAlertaUpdateIn,
    CanaisPreferencias,
    CanalStatus,
    DispositivoIn,
    DispositivoOut,
)
from app.services.estoque_rendimento import (
    e_rendimento,
    quantidade_consumo_disponivel,
    unidade_consumo,
)


_CAMPOS_ITEM_ESTOQUE = (
    "id, nome, unidade, quantidade_atual, quantidade_minima, modo_controle, "
    "usos_por_unidade, usos_minimos"
)


def _registrar_alerta_vivo(supabase: Client, user_id: str, chave: str, dados: dict) -> None:
    """Mantém uma única ocorrência aberta, preservando o histórico resolvido."""
    tabela = supabase.table("alertas")
    existentes = rows(
        tabela.select("id")
        .eq("user_id", user_id)
        .eq("chave_dedupe", chave)
        .is_("resolvido_em", "null")
        .limit(1)
        .execute().data
    )
    if existentes:
        tabela.update(dados).eq("id", existentes[0]["id"]).eq("user_id", user_id).execute()
        return
    try:
        tabela.insert(dados).execute()
    except APIError as exc:
        # O índice parcial único cobre duas consultas à central que ocorram ao
        # mesmo tempo. A segunda apenas atualiza a ocorrência vencedora.
        if getattr(exc, "code", None) != "23505":
            raise
        tabela.update(dados).eq("user_id", user_id).eq("chave_dedupe", chave).is_(
            "resolvido_em", "null"
        ).execute()


def _sincronizar_alertas_estoque(supabase: Client, user_id: str) -> None:
    """Calcula a central pelo saldo lógico sem depender de abrir Estoque.

    Itens por rendimento usam usos; os demais usam sua quantidade cadastrada.
    Uma única chave por item evita ruído quando a consulta é feita muitas vezes.
    """
    itens = rows(
        supabase.table("estoque_itens")
        .select(_CAMPOS_ITEM_ESTOQUE)
        .eq("user_id", user_id)
        .eq("ativo", True)
        .execute().data
    )
    agora_iso = datetime.now(timezone.utc).isoformat()
    for item in itens:
        por_usos = e_rendimento(item)
        saldo = (
            quantidade_consumo_disponivel(item)
            if por_usos
            else float(item.get("quantidade_atual") or 0)
        )
        limite = float(item.get("usos_minimos") if por_usos else item.get("quantidade_minima") or 0)
        unidade = unidade_consumo(item)
        chave = f"estoque_condicao:{item['id']}"

        if saldo < 0:
            tipo, severidade = "estoque_negativo", "critico"
            titulo = f"Estoque negativo: {item['nome']}"
            mensagem = f"Há {abs(saldo):g} {unidade}(s) registrados sem saldo em {item['nome']}."
        elif saldo == 0:
            tipo, severidade = "estoque_critico", "critico"
            titulo = f"Sem {unidade}(s) disponíveis: {item['nome']}"
            mensagem = f"{item['nome']} não tem mais {unidade}(s) disponíveis."
        elif saldo <= limite:
            tipo, severidade = "estoque_baixo", "alerta"
            titulo = f"Poucos {unidade}(s) disponíveis: {item['nome']}"
            mensagem = f"Restam {saldo:g} {unidade}(s) de {item['nome']}; o aviso está em {limite:g}."
        else:
            tipo = None

        if tipo is None:
            (
                supabase.table("alertas")
                .update({"resolvido_em": agora_iso})
                .eq("user_id", user_id)
                .eq("referencia_tipo", "estoque_item")
                .eq("referencia_id", item["id"])
                .is_("resolvido_em", "null")
                .execute()
            )
            continue

        # Alertas específicos de uma finalização forçada e os criados pelas
        # versões anteriores são substituídos pela condição atual do produto.
        # Assim a central continua com um aviso, e não vários, para o mesmo item.
        (
            supabase.table("alertas")
            .update({"resolvido_em": agora_iso})
            .eq("user_id", user_id)
            .eq("referencia_tipo", "estoque_item")
            .eq("referencia_id", item["id"])
            .neq("chave_dedupe", chave)
            .is_("resolvido_em", "null")
            .execute()
        )
        _registrar_alerta_vivo(
            supabase,
            user_id,
            chave,
            {
                "user_id": user_id,
                "tipo": tipo,
                "severidade": severidade,
                "titulo": titulo,
                "mensagem": mensagem,
                "referencia_tipo": "estoque_item",
                "referencia_id": item["id"],
                "chave_dedupe": chave,
                "resolvido_em": None,
            },
        )


def _converter_linha_alerta(linha: dict) -> AlertaOut:
    return AlertaOut(
        id=str(linha["id"]),
        tipo=str(linha["tipo"]),
        severidade=str(linha["severidade"]),
        titulo=str(linha["titulo"]),
        mensagem=str(linha.get("mensagem", "")),
        referencia_tipo=linha.get("referencia_tipo"),
        referencia_id=linha.get("referencia_id"),
        criado_em=linha["criado_em"],
        lido_em=linha.get("lido_em"),
    )


def listar_alertas(
    supabase: Client,
    user_id: str,
    apenas_nao_lidos: bool | None = None,
    tipo: str | None = None,
    severidade: str | None = None,
) -> AlertasListaOut:
    _sincronizar_alertas_estoque(supabase, user_id)
    query = supabase.table("alertas").select("*").eq("user_id", user_id).is_("resolvido_em", "null")

    if apenas_nao_lidos is True:
        query = query.is_("lido_em", "null")
    elif apenas_nao_lidos is False:
        query = query.not_.is_("lido_em", "null")

    if tipo:
        query = query.eq("tipo", tipo)
    if severidade:
        query = query.eq("severidade", severidade)

    linhas = rows(query.order("criado_em", desc=True).execute().data)

    # Busca todos os ativos não lidos para calcular o badge e resumo
    resp_ativos_nao_lidos = (
        supabase.table("alertas")
        .select("severidade")
        .eq("user_id", user_id)
        .is_("resolvido_em", "null")
        .is_("lido_em", "null")
        .execute()
    )
    nao_lidos_linhas = rows(resp_ativos_nao_lidos.data)
    total_nao_lidos = len(nao_lidos_linhas)

    critico_count = sum(1 for a in nao_lidos_linhas if a.get("severidade") == "critico")
    alerta_count = sum(1 for a in nao_lidos_linhas if a.get("severidade") == "alerta")
    info_count = sum(1 for a in nao_lidos_linhas if a.get("severidade") == "info")

    resumo = AlertasResumo(critico=critico_count, alerta=alerta_count, info=info_count)
    alertas_out = [_converter_linha_alerta(linha) for linha in linhas]

    return AlertasListaOut(
        total_nao_lidos=total_nao_lidos,
        resumo=resumo,
        alertas=alertas_out,
    )


def marcar_alerta_lido(supabase: Client, user_id: str, alerta_id: str) -> AlertaOut:
    resp = (
        supabase.table("alertas")
        .select("*")
        .eq("user_id", user_id)
        .eq("id", alerta_id)
        .execute()
    )
    if not rows(resp.data):
        raise HTTPException(
            status_code=404,
            detail={"codigo": "RECURSO_NAO_ENCONTRADO", "mensagem": "Alerta não encontrado"},
        )

    agora_iso = datetime.now(timezone.utc).isoformat()
    supabase.table("alertas").update({"lido_em": agora_iso}).eq("id", alerta_id).eq("user_id", user_id).execute()

    resp_atualizada = (
        supabase.table("alertas")
        .select("*")
        .eq("id", alerta_id)
        .execute()
    )
    linha_atualizada = row(resp_atualizada.data)
    return _converter_linha_alerta(linha_atualizada)


def marcar_todos_lidos(supabase: Client, user_id: str, dados: MarcarLidosIn) -> None:
    agora_iso = datetime.now(timezone.utc).isoformat()
    query = (
        supabase.table("alertas")
        .update({"lido_em": agora_iso})
        .eq("user_id", user_id)
        .is_("lido_em", "null")
    )
    if dados.tipo:
        query = query.eq("tipo", dados.tipo)
    query.execute()


def _buscar_preferencias_db(supabase: Client, user_id: str) -> dict:
    resp = (
        supabase.table("alerta_preferencias")
        .select("*")
        .eq("user_id", user_id)
        .execute()
    )
    linhas = rows(resp.data)
    if not linhas:
        insert_resp = (
            supabase.table("alerta_preferencias")
            .insert({
                "user_id": user_id,
                "limite_saldo_alerta": 0.0,
                "dias_antecedencia_vencimento": 7,
                "canal_in_app": True,
                "canal_push": True,
                "canal_whatsapp": False,
                "canal_email": False,
                "tipos_silenciados": [],
            })
            .execute()
        )
        return row(insert_resp.data)
    return linhas[0]


def obter_preferencias(supabase: Client, user_id: str) -> PreferenciasAlertaOut:
    linha = _buscar_preferencias_db(supabase, user_id)
    return PreferenciasAlertaOut(
        limite_saldo_alerta=float(linha.get("limite_saldo_alerta", 0.0)),
        dias_antecedencia_vencimento=int(linha.get("dias_antecedencia_vencimento", 7)),
        canais=CanaisPreferencias(
            in_app=CanalStatus(ativo=bool(linha.get("canal_in_app", True))),
            push=CanalStatus(ativo=bool(linha.get("canal_push", True))),
            whatsapp=CanalStatus(ativo=bool(linha.get("canal_whatsapp", False))),
            email=CanalStatus(ativo=bool(linha.get("canal_email", False))),
        ),
        tipos_silenciados=linha.get("tipos_silenciados") or [],
    )


def atualizar_preferencias(
    supabase: Client, user_id: str, dados: PreferenciasAlertaUpdateIn
) -> PreferenciasAlertaOut:
    _buscar_preferencias_db(supabase, user_id)
    campos = {
        "limite_saldo_alerta": dados.limite_saldo_alerta,
        "dias_antecedencia_vencimento": dados.dias_antecedencia_vencimento,
        "canal_in_app": dados.canais.in_app.ativo,
        "canal_push": dados.canais.push.ativo,
        "canal_whatsapp": dados.canais.whatsapp.ativo,
        "canal_email": dados.canais.email.ativo,
        "tipos_silenciados": dados.tipos_silenciados,
    }
    supabase.table("alerta_preferencias").update(campos).eq("user_id", user_id).execute()
    return obter_preferencias(supabase, user_id)


def registrar_dispositivo(supabase: Client, user_id: str, dados: DispositivoIn) -> DispositivoOut:
    agora_iso = datetime.now(timezone.utc).isoformat()
    resp = (
        supabase.table("dispositivos")
        .upsert(
            {
                "user_id": user_id,
                "token": dados.token,
                "plataforma": dados.plataforma,
                "modelo": dados.modelo,
                "ativo": True,
                "usado_em": agora_iso,
            },
            on_conflict="token",
        )
        .execute()
    )
    linha = row(resp.data)
    return DispositivoOut(
        id=str(linha["id"]),
        token=str(linha["token"]),
        plataforma=str(linha["plataforma"]),
        modelo=str(linha.get("modelo", "")),
        ativo=bool(linha.get("ativo", True)),
    )


def remover_dispositivo(supabase: Client, user_id: str, token: str) -> None:
    supabase.table("dispositivos").delete().eq("user_id", user_id).eq("token", token).execute()
