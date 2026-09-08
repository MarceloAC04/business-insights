"""Regras de `estoque` (endpoints-backend.md §5, A6)."""

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from math import ceil

from fastapi import HTTPException
from postgrest.exceptions import APIError
from supabase import Client

from app.core.supabase_client import row, rows
from app.schemas.estoque import ItemIn, ItemPatchIn, MovimentacaoIn
from app.services.estoque_rendimento import (
    custo_por_unidade_consumo,
    e_rendimento,
    quantidade_consumo_disponivel,
    unidade_consumo,
)

_CAMPOS_ITEM = (
    "id, nome, unidade, categoria, quantidade_atual, quantidade_minima, custo_medio, "
    "custo_ultima_compra, status, deficit, ativo, codigo_barras, modo_controle, "
    "usos_por_unidade, usos_minimos"
)


def _agora() -> datetime:
    return datetime.now(timezone.utc)

def _enriquecer_item(item: dict) -> dict:
    """
    Adiciona a capacidade e o custo por uso para potes/frascos. O saldo físico
    continua no banco; o uso é a unidade que a profissional acompanha.
    """
    item["usos_disponiveis"] = None
    item["custo_por_uso"] = None
    item["deficit_usos"] = None
    item["status_rendimento"] = None

    if e_rendimento(item):
        disponiveis = quantidade_consumo_disponivel(item)
        minimo = float(item.get("usos_minimos") or 0)
        item["usos_disponiveis"] = disponiveis
        item["custo_por_uso"] = custo_por_unidade_consumo(item)
        item["deficit_usos"] = max(0, minimo - disponiveis)
        item["status_rendimento"] = (
            "negativo"
            if disponiveis < 0
            else "critico"
            if disponiveis <= 0
            else "alerta"
            if disponiveis <= minimo
            else "ok"
        )
        return item
    return item


def _ajustar_estoque(supabase: Client, user_id: str, item_id: str, delta: float, permitir_negativo: bool) -> dict | None:
    """
    Mesmo RPC atômico de `atendimentos_service._ajustar_estoque` — `saldo` não
    pode ser lido aqui e escrito de volta como valor literal (era isso que
    `criar_movimentacao` fazia): duas movimentações do mesmo item ao mesmo
    tempo (ex.: uma entrada manual e uma baixa de atendimento) se
    sobrescreveriam, e uma ficaria perdida. `p_user_id` explícito porque quem
    chama aqui é o `service_role` — sem JWT de usuária na sessão, `auth.uid()`
    seria `null` (006_ajustar_estoque_rpc_service_role.sql). Devolve `None`
    quando a trava impediu o update (saldo insuficiente e `permitir_negativo=False`).
    """
    resp = supabase.rpc(
        "ajustar_estoque",
        {
            "p_item_id": item_id,
            "p_delta": delta,
            "p_permitir_negativo": permitir_negativo,
            "p_user_id": user_id,
        },
    ).execute()
    linhas = rows(resp.data)
    return linhas[0] if linhas else None


def _validar_codigo_barras_livre(
    supabase: Client, user_id: str, codigo_barras: str, ignorar_item_id: str | None = None
) -> None:
    query = (
        supabase.table("estoque_itens")
        .select("id")
        .eq("user_id", user_id)
        .eq("codigo_barras", codigo_barras)
    )
    if ignorar_item_id:
        query = query.neq("id", ignorar_item_id)
    if rows(query.execute().data):
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "CODIGO_BARRAS_JA_CADASTRADO",
                "mensagem": "Esse código de barras já está em uso por outro item.",
            },
        )




def _buscar_item(supabase: Client, user_id: str, item_id: str) -> dict:
    resp = (
        supabase.table("estoque_itens")
        .select(_CAMPOS_ITEM)
        .eq("user_id", user_id)
        .eq("id", item_id)
        .execute()
    )
    linhas = rows(resp.data)
    if not linhas:
        raise HTTPException(
            status_code=404,
            detail={"codigo": "RECURSO_NAO_ENCONTRADO", "mensagem": "Item de estoque não encontrado"},
        )
    return _enriquecer_item(linhas[0])


def _registrar_alerta_vivo(supabase: Client, user_id: str, chave: str, dados: dict) -> None:
    """Atualiza o alerta vivo ou cria um novo sem depender de `upsert` parcial.

    `001_v1_completo.sql` usa índice único parcial para permitir várias
    ocorrências históricas da mesma chave depois que a anterior foi resolvida.
    O PostgREST não aceita esse índice como alvo de `on_conflict`, portanto um
    `upsert(..., on_conflict="user_id,chave_dedupe")` devolve 42P10 no banco
    real. A leitura/atualização preserva o histórico e a captura de 23505 cobre
    a corrida entre duas listagens simultâneas.
    """
    tabela = supabase.table("alertas")
    existentes = rows(
        tabela.select("id")
        .eq("user_id", user_id)
        .eq("chave_dedupe", chave)
        .is_("resolvido_em", "null")
        .limit(1)
        .execute()
        .data
    )
    if existentes:
        tabela.update(dados).eq("id", existentes[0]["id"]).eq("user_id", user_id).execute()
        return

    try:
        tabela.insert(dados).execute()
    except APIError as exc:
        if getattr(exc, "code", None) != "23505":
            raise
        tabela.update(dados).eq("user_id", user_id).eq("chave_dedupe", chave).is_(
            "resolvido_em", "null"
        ).execute()


def _gerar_alertas_rendimento(supabase: Client, user_id: str, itens: list[dict]) -> None:
    """Espelha a reposição por usos na central de alertas, sem abrir pote."""
    agora_iso = _agora().isoformat()
    for item in itens:
        if not e_rendimento(item):
            continue
        chave = f"estoque_rendimento:{item['id']}"
        status = item.get("status_rendimento")
        if status in ("alerta", "critico", "negativo"):
            disponiveis = float(item.get("usos_disponiveis") or 0)
            if status == "negativo":
                titulo = f"Estoque negativo: {item['nome']}"
                mensagem = f"{item['nome']} passou da capacidade disponível de usos."
                tipo, severidade = "estoque_negativo", "alerta"
            elif status == "critico":
                titulo = f"Sem usos disponíveis: {item['nome']}"
                mensagem = f"{item['nome']} não tem mais usos disponíveis para atendimentos."
                tipo, severidade = "estoque_critico", "critico"
            else:
                titulo = f"Poucos usos disponíveis: {item['nome']}"
                mensagem = f"Restam {disponiveis:g} uso(s) de {item['nome']}."
                tipo, severidade = "estoque_baixo", "alerta"
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
        else:
            supabase.table("alertas").update({"resolvido_em": agora_iso}).eq(
                "user_id", user_id
            ).eq("chave_dedupe", chave).is_("resolvido_em", "null").execute()


_JANELA_PLANEJAMENTO_DIAS = 30
_COBERTURA_REPOSICAO_DIAS = 14


def _quantidade_logica_movimentada(item: dict, movimentacao: dict) -> float:
    """Converte o histórico para a unidade que a profissional acompanha."""
    if not e_rendimento(item):
        return float(movimentacao.get("quantidade") or 0)

    if movimentacao.get("unidade_consumo") == "uso" and movimentacao.get("quantidade_consumida") is not None:
        return float(movimentacao["quantidade_consumida"])
    # Histórico anterior à migração 012 não trazia a quantidade lógica. Para
    # ele, a fração física ainda pode ser convertida pelo rendimento atual;
    # dados novos sempre seguem o primeiro ramo e preservam sua conversão.
    return float(movimentacao.get("quantidade") or 0) * float(item.get("usos_por_unidade") or 1)


def _montar_planejamento_reposicao(
    itens: list[dict],
    saidas_ultimos_30_dias: list[dict],
    consumo_agendado_por_item: dict[str, float],
    atendimentos_agendados: int,
) -> list[dict]:
    """Transforma saldo, histórico e agenda em uma sugestão que pode ser auditada.

    A meta cobre o limite configurado, os materiais já reservados na agenda e
    14 dias da média recente. Não altera configurações nem registra entrada ou
    gasto: a profissional continua decidindo se, quando e onde comprar.
    """
    por_item = {str(item["id"]): item for item in itens}
    consumo_historico: dict[str, float] = defaultdict(float)
    for movimento in saidas_ultimos_30_dias:
        item = por_item.get(str(movimento.get("item_id")))
        if item:
            consumo_historico[str(item["id"])] += _quantidade_logica_movimentada(item, movimento)

    planejamento: list[dict] = []
    for item in itens:
        item_id = str(item["id"])
        por_usos = e_rendimento(item)
        unidade = unidade_consumo(item)
        atual = float((item.get("usos_disponiveis") if por_usos else item.get("quantidade_atual")) or 0)
        minimo = float((item.get("usos_minimos") if por_usos else item.get("quantidade_minima")) or 0)
        medio_diario = consumo_historico[item_id] / _JANELA_PLANEJAMENTO_DIAS
        agendado = float(consumo_agendado_por_item.get(item_id, 0))
        meta = minimo + agendado + medio_diario * _COBERTURA_REPOSICAO_DIAS
        sugerida = max(0, meta - atual)
        if sugerida <= 0:
            continue

        base = (
            f"Limite de {minimo:g} {unidade}(s) + agenda de {agendado:g} {unidade}(s)"
            f" + {medio_diario:g} {unidade}(s)/dia pela média dos últimos "
            f"{_JANELA_PLANEJAMENTO_DIAS} dias."
        )
        planejamento.append({
            "item_id": item_id,
            "nome": item["nome"],
            "unidade_consumo": unidade,
            "quantidade_atual": atual,
            "quantidade_minima": minimo,
            "consumo_medio_diario": medio_diario,
            "consumo_agendado": agendado,
            "atendimentos_agendados": atendimentos_agendados if agendado else 0,
            "quantidade_sugerida": sugerida,
            "embalagens_sugeridas": ceil(sugerida / float(item["usos_por_unidade"])) if por_usos else None,
            "base_calculo": base,
        })
    return sorted(planejamento, key=lambda item: (-item["quantidade_sugerida"], item["nome"].lower()))


def _planejar_reposicao(supabase: Client, user_id: str, itens: list[dict]) -> list[dict]:
    if not itens:
        return []

    agora = _agora()
    inicio_historico = (agora - timedelta(days=_JANELA_PLANEJAMENTO_DIAS)).isoformat()
    fim_agenda = (agora + timedelta(days=_JANELA_PLANEJAMENTO_DIAS)).isoformat()
    saidas = rows(
        supabase.table("estoque_movimentacoes")
        .select("item_id, quantidade, quantidade_consumida, unidade_consumo")
        .eq("user_id", user_id)
        .eq("tipo", "saida")
        .gte("criado_em", inicio_historico)
        .execute().data
    )
    agendamentos = rows(
        supabase.table("atendimentos")
        .select("id")
        .eq("user_id", user_id)
        .eq("status", "agendado")
        .gte("data", agora.isoformat())
        .lt("data", fim_agenda)
        .execute().data
    )
    ids_agendamentos = [str(atendimento["id"]) for atendimento in agendamentos]
    consumo_agendado: dict[str, float] = defaultdict(float)
    if ids_agendamentos:
        servicos_agendados = rows(
            supabase.table("atendimento_servicos")
            .select("servico_id")
            .in_("atendimento_id", ids_agendamentos)
            .execute().data
        )
        quantidade_por_servico = Counter(
            str(linha["servico_id"]) for linha in servicos_agendados if linha.get("servico_id")
        )
        if quantidade_por_servico:
            composicoes = rows(
                supabase.table("servico_produtos_padrao")
                .select("servico_id, item_estoque_id, quantidade")
                .in_("servico_id", list(quantidade_por_servico))
                .execute().data
            )
            for composicao in composicoes:
                repeticoes = quantidade_por_servico.get(str(composicao["servico_id"]), 0)
                consumo_agendado[str(composicao["item_estoque_id"])] += (
                    float(composicao["quantidade"]) * repeticoes
                )

    return _montar_planejamento_reposicao(itens, saidas, consumo_agendado, len(ids_agendamentos))


def listar(
    supabase: Client,
    user_id: str,
    status: str | None,
    categoria: str | None,
    ativo: bool | None,
    codigo_barras: str | None = None,
) -> dict:
    query = supabase.table("estoque_itens").select(_CAMPOS_ITEM).eq("user_id", user_id)
    if status:
        query = query.eq("status", status)
    if categoria:
        query = query.eq("categoria", categoria)
    if codigo_barras:
        query = query.eq("codigo_barras", codigo_barras)
    if ativo is not None:
        query = query.eq("ativo", ativo)
    else:
        query = query.eq("ativo", True)
    itens = [_enriquecer_item(i) for i in rows(query.order("nome").execute().data)]

    total_alertas = sum(
        1
        for i in itens
        if i["status"] in ("alerta", "critico", "negativo")
        or i["status_rendimento"] in ("alerta", "critico", "negativo")
    )
    valor_total = sum(float(i["quantidade_atual"]) * float(i["custo_medio"]) for i in itens if float(i["quantidade_atual"]) > 0)
    return {
        "total_alertas": total_alertas,
        "valor_total": valor_total,
        "itens": itens,
        "planejamento_reposicao": _planejar_reposicao(supabase, user_id, itens),
    }


def criar(supabase: Client, user_id: str, body: ItemIn) -> dict:
    if body.codigo_barras:
        _validar_codigo_barras_livre(supabase, user_id, body.codigo_barras)
    campos = {
        "user_id": user_id,
        "nome": body.nome,
        "unidade": body.unidade,
        "categoria": body.categoria,
        "quantidade_atual": body.quantidade_atual,
        "quantidade_minima": body.quantidade_minima,
        "custo_medio": body.custo_unitario,
        "custo_ultima_compra": body.custo_unitario,
        "codigo_barras": body.codigo_barras,
        "ativo": True,
        "modo_controle": body.modo_controle,
        "usos_por_unidade": body.usos_por_unidade,
        "usos_minimos": body.usos_minimos if body.usos_minimos is not None else 0,
    }
    resp = supabase.table("estoque_itens").insert(campos).execute()
    criado = row(resp.data)
    return _buscar_item(supabase, user_id, str(criado["id"]))


def editar(supabase: Client, user_id: str, item_id: str, body: ItemPatchIn) -> dict:
    item_atual = _buscar_item(supabase, user_id, item_id)
    campos = {}
    if body.nome is not None:
        campos["nome"] = body.nome
    if body.unidade is not None:
        campos["unidade"] = body.unidade
    if body.categoria is not None:
        campos["categoria"] = body.categoria
    if body.quantidade_minima is not None:
        campos["quantidade_minima"] = body.quantidade_minima
    # `None` também é uma edição válida: remove um código antes cadastrado.
    if "codigo_barras" in body.model_fields_set:
        if body.codigo_barras:
            _validar_codigo_barras_livre(
                supabase, user_id, body.codigo_barras, ignorar_item_id=item_id
            )
        campos["codigo_barras"] = body.codigo_barras
    modo_destino = body.modo_controle or item_atual.get("modo_controle") or "quantidade"
    unidade_destino = body.unidade or item_atual.get("unidade")
    usos_destino = (
        body.usos_por_unidade
        if "usos_por_unidade" in body.model_fields_set
        else item_atual.get("usos_por_unidade")
    )
    if modo_destino == "rendimento_usos":
        if (
            item_atual.get("modo_controle") != "rendimento_usos"
            and item_atual.get("unidade") != "un"
            and not body.confirmar_unidade_fisica
        ):
            raise HTTPException(
                status_code=422,
                detail={
                    "codigo": "CONFERIR_UNIDADE_FISICA",
                    "mensagem": "Confira o saldo em embalagens antes de mudar este produto para controle por usos.",
                },
            )
        if unidade_destino != "un" or not usos_destino or float(usos_destino) <= 0:
            raise HTTPException(
                status_code=422,
                detail={
                    "codigo": "VALIDACAO_INVALIDA",
                    "mensagem": "Rendimento por usos precisa de unidade 'un' e usos por embalagem maior que zero.",
                },
            )
        campos["usos_por_unidade"] = usos_destino
        if "usos_minimos" in body.model_fields_set:
            campos["usos_minimos"] = body.usos_minimos or 0
    elif "usos_por_unidade" in body.model_fields_set:
        campos["usos_por_unidade"] = body.usos_por_unidade
    if "usos_minimos" in body.model_fields_set and modo_destino != "rendimento_usos":
        campos["usos_minimos"] = body.usos_minimos or 0

    if body.modo_controle is not None:
        campos["modo_controle"] = body.modo_controle
        if body.modo_controle == "quantidade":
            campos["usos_por_unidade"] = None
            campos["usos_minimos"] = 0
    if campos:
        supabase.table("estoque_itens").update(campos).eq("id", item_id).eq("user_id", user_id).execute()
    return _buscar_item(supabase, user_id, item_id)


def excluir(supabase: Client, user_id: str, item_id: str) -> None:
    _buscar_item(supabase, user_id, item_id)
    resp = (
        supabase.table("estoque_movimentacoes")
        .select("id")
        .eq("item_id", item_id)
        .limit(1)
        .execute()
    )
    if rows(resp.data):
        supabase.table("estoque_itens").update({"ativo": False}).eq("id", item_id).eq("user_id", user_id).execute()
    else:
        supabase.table("estoque_itens").delete().eq("id", item_id).eq("user_id", user_id).execute()


def criar_movimentacao(supabase: Client, user_id: str, item_id: str, body: MovimentacaoIn) -> dict:
    item = _buscar_item(supabase, user_id, item_id)

    if body.tipo == "ajuste":
        # Contagem é saldo absoluto, não delta. O RPC trava a linha e grava
        # saldo + histórico juntos, inclusive zero (migração 011).
        resp = supabase.rpc("conferir_estoque", {
            "p_item_id": item_id,
            "p_quantidade": body.quantidade,
            "p_motivo": body.motivo,
            "p_user_id": user_id,
        }).execute()
        if not rows(resp.data):
            raise HTTPException(status_code=404, detail={
                "codigo": "RECURSO_NAO_ENCONTRADO",
                "mensagem": "Item de estoque não encontrado",
            })
        return _buscar_item(supabase, user_id, item_id)

    qtd_atual = float(item["quantidade_atual"])
    custo_medio = float(item["custo_medio"])
    custo_ultima = float(item["custo_ultima_compra"])

    if body.tipo == "saida" and qtd_atual < body.quantidade:
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ESTOQUE_INSUFICIENTE",
                "mensagem": "Saldo insuficiente para essa saída.",
                "result": {
                    "faltantes": [{
                        "item_estoque_id": item["id"],
                        "nome": item["nome"],
                        "unidade": item["unidade"],
                        "quantidade_solicitada": body.quantidade,
                        "quantidade_disponivel": qtd_atual,
                        "deficit": body.quantidade - qtd_atual,
                    }]
                },
            },
        )

    # Média ponderada móvel (A6) calculada com o saldo de ANTES do ajuste — o
    # RPC abaixo só mexe em `quantidade_atual`, custo é sempre um update à parte.
    novo_custo_medio = custo_medio
    novo_custo_ultima_compra = custo_ultima
    if body.tipo == "entrada" and body.custo_unitario is not None:
        if qtd_atual <= 0:
            novo_custo_medio = body.custo_unitario
        else:
            novo_custo_medio = (
                qtd_atual * custo_medio + body.quantidade * body.custo_unitario
            ) / (qtd_atual + body.quantidade)
        novo_custo_ultima_compra = body.custo_unitario

    delta = -body.quantidade if body.tipo == "saida" else body.quantidade
    permitir_negativo = body.tipo != "saida"

    # Ajuste atômico pelo RPC — nunca leitura-depois-escrita: duas
    # movimentações do mesmo item ao mesmo tempo (entrada manual e baixa de
    # atendimento, por exemplo) não podem se sobrescrever.
    resultado = _ajustar_estoque(supabase, user_id, item_id, delta, permitir_negativo)
    if resultado is None:
        resp_atual = supabase.table("estoque_itens").select("quantidade_atual").eq("id", item_id).execute()
        atual = row(resp_atual.data)
        disponivel = float(atual["quantidade_atual"]) if atual else qtd_atual
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ESTOQUE_INSUFICIENTE",
                "mensagem": "Saldo insuficiente para essa saída.",
                "result": {
                    "faltantes": [{
                        "item_estoque_id": item["id"],
                        "nome": item["nome"],
                        "unidade": item["unidade"],
                        "quantidade_solicitada": body.quantidade,
                        "quantidade_disponivel": disponivel,
                        "deficit": body.quantidade - disponivel,
                    }]
                },
            },
        )

    supabase.table("estoque_movimentacoes").insert({
        "user_id": user_id,
        "item_id": item_id,
        "tipo": body.tipo,
        "quantidade": body.quantidade,
        "motivo": body.motivo,
        "custo_unitario": body.custo_unitario,
        "forcada": False,
    }).execute()

    campos_item = {}
    if novo_custo_medio != custo_medio or novo_custo_ultima_compra != custo_ultima:
        campos_item["custo_medio"] = novo_custo_medio
        campos_item["custo_ultima_compra"] = novo_custo_ultima_compra

    if campos_item:
        supabase.table("estoque_itens").update(campos_item).eq("id", item_id).eq("user_id", user_id).execute()

    return _buscar_item(supabase, user_id, item_id)


def listar_movimentacoes(
    supabase: Client,
    user_id: str,
    item_id: str | None,
    inicio: str | None,
    fim: str | None,
    tipo: str | None,
) -> dict:
    query = supabase.table("estoque_movimentacoes").select(
        "id, item_id, tipo, quantidade, motivo, atendimento_id, criado_em, saldo_anterior, saldo_atual, "
        "quantidade_consumida, unidade_consumo"
    ).eq("user_id", user_id)
    if item_id:
        query = query.eq("item_id", item_id)
    if tipo:
        query = query.eq("tipo", tipo)
    if inicio:
        query = query.gte("criado_em", f"{inicio}T00:00:00-03:00")
    if fim:
        query = query.lte("criado_em", f"{fim}T23:59:59-03:00")
    linhas = rows(query.order("criado_em", desc=True).execute().data)

    ids_item = list({str(m["item_id"]) for m in linhas})
    nomes: dict[str, str] = {}
    if ids_item:
        resp_itens = supabase.table("estoque_itens").select("id, nome").in_("id", ids_item).execute()
        nomes = {str(i["id"]): str(i["nome"]) for i in rows(resp_itens.data)}

    return {
        "movimentacoes": [
            {
                "id": m["id"],
                "item_id": m["item_id"],
                "item_nome": nomes.get(str(m["item_id"]), ""),
                "tipo": m["tipo"],
                "quantidade": m["quantidade"],
                "motivo": m["motivo"],
                "atendimento_id": m.get("atendimento_id"),
                "criado_em": m["criado_em"],
                "saldo_anterior": m.get("saldo_anterior"),
                "saldo_atual": m.get("saldo_atual"),
                "quantidade_consumida": m.get("quantidade_consumida"),
                "unidade_consumo": m.get("unidade_consumo"),
            }
            for m in linhas
        ]
    }
