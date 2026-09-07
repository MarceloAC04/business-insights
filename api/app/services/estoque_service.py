"""Regras de `estoque` (endpoints-backend.md §5, A6)."""

from datetime import datetime, timezone

from fastapi import HTTPException
from supabase import Client

from app.core.supabase_client import row, rows
from app.schemas.estoque import ItemIn, ItemPatchIn, MovimentacaoIn

_CAMPOS_ITEM = (
    "id, nome, unidade, categoria, quantidade_atual, quantidade_minima, custo_medio, "
    "custo_ultima_compra, status, deficit, ativo, codigo_barras, modo_controle, "
    "duracao_dias, duracao_atendimentos, unidade_aberta_em, atendimentos_desde_abertura"
)

# Limiares do aviso de "acabando" por validade — mesmo espírito do
# `quantidade_atual <= quantidade_minima` já usado pra saldo, só que aqui
# não tem um "mínimo" configurável por item: um valor fixo e razoável pra
# um salão pequeno perceber a tempo de repor.
_DIAS_LIMIAR_ALERTA = 5
_ATENDIMENTOS_LIMIAR_ALERTA = 3


def _agora() -> datetime:
    return datetime.now(timezone.utc)


def _enriquecer_validade(item: dict) -> dict:
    """
    Adiciona `dias_restantes`/`atendimentos_restantes`/`status_validade` —
    não dá pra ser coluna gerada no Postgres porque depende de `now()`
    (não é uma expressão imutável). Fica de fora (`None`) para itens no
    modo `quantidade`, que já tem seu próprio `status` calculado no banco.
    """
    modo = item.get("modo_controle") or "quantidade"
    item["dias_restantes"] = None
    item["atendimentos_restantes"] = None
    item["status_validade"] = None

    aberta_em = item.get("unidade_aberta_em")
    if modo == "validade_dias" and item.get("duracao_dias") and aberta_em:
        aberta = datetime.fromisoformat(str(aberta_em).replace("Z", "+00:00"))
        dias_passados = (_agora() - aberta).total_seconds() / 86400
        restantes = int(item["duracao_dias"]) - int(dias_passados)
        item["dias_restantes"] = restantes
        item["status_validade"] = (
            "critico" if restantes <= 0 else "alerta" if restantes <= _DIAS_LIMIAR_ALERTA else "ok"
        )
    elif modo == "validade_atendimentos" and item.get("duracao_atendimentos"):
        restantes = int(item["duracao_atendimentos"]) - int(item.get("atendimentos_desde_abertura") or 0)
        item["atendimentos_restantes"] = restantes
        item["status_validade"] = (
            "critico"
            if restantes <= 0
            else "alerta" if restantes <= _ATENDIMENTOS_LIMIAR_ALERTA else "ok"
        )
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
    return _enriquecer_validade(linhas[0])


def _gerar_alertas_validade(supabase: Client, user_id: str, itens: list[dict]) -> None:
    """
    Espelha em `alertas` o `status_validade` calculado em `_enriquecer_validade`
    — sem isso, item com validade acabando só aparecia como badge na tela de
    Estoque, sem chegar na central de alertas/badge global/WhatsApp que os
    outros tipos de alerta já usam. `chave_dedupe` faz o upsert idempotente
    (mesmo padrão de `atendimentos_service`'s `estoque_negativo`): roda a cada
    listagem sem duplicar linha, e resolve o alerta sozinho quando o item volta
    a ficar "ok" (troca de unidade, ajuste manual etc.).
    """
    agora_iso = _agora().isoformat()
    for item in itens:
        modo = item.get("modo_controle") or "quantidade"
        if modo == "quantidade":
            continue
        chave = f"validade:{item['id']}"
        status = item.get("status_validade")
        if status in ("alerta", "critico"):
            if status == "critico":
                titulo = f"Validade vencida: {item['nome']}"
                mensagem = (
                    f"{item['nome']} passou da validade — provavelmente já ressecou/venceu."
                    if modo == "validade_dias"
                    else f"{item['nome']} já rendeu mais atendimentos do que devia — hora de abrir outra unidade."
                )
                tipo = "validade_vencida"
            else:
                restante = item.get("dias_restantes") if modo == "validade_dias" else item.get("atendimentos_restantes")
                unidade_txt = "dia(s)" if modo == "validade_dias" else "atendimento(s)"
                titulo = f"Validade acabando: {item['nome']}"
                mensagem = f"Faltam {restante} {unidade_txt} para {item['nome']} vencer."
                tipo = "validade_proxima"
            supabase.table("alertas").upsert(
                {
                    "user_id": user_id,
                    "tipo": tipo,
                    "severidade": status,
                    "titulo": titulo,
                    "mensagem": mensagem,
                    "referencia_tipo": "estoque_item",
                    "referencia_id": item["id"],
                    "chave_dedupe": chave,
                    "resolvido_em": None,
                },
                on_conflict="user_id,chave_dedupe",
            ).execute()
        else:
            supabase.table("alertas").update({"resolvido_em": agora_iso}).eq(
                "user_id", user_id
            ).eq("chave_dedupe", chave).is_("resolvido_em", "null").execute()


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
    itens = [_enriquecer_validade(i) for i in rows(query.order("nome").execute().data)]

    total_alertas = sum(
        1
        for i in itens
        if i["status"] in ("alerta", "critico", "negativo")
        or i["status_validade"] in ("alerta", "critico")
    )
    valor_total = sum(float(i["quantidade_atual"]) * float(i["custo_medio"]) for i in itens if float(i["quantidade_atual"]) > 0)
    _gerar_alertas_validade(supabase, user_id, itens)
    return {"total_alertas": total_alertas, "valor_total": valor_total, "itens": itens}


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
        "duracao_dias": body.duracao_dias,
        "duracao_atendimentos": body.duracao_atendimentos,
    }
    if body.modo_controle != "quantidade":
        # Cadastrar já é "abrir a primeira unidade": começa a contar
        # dias/atendimentos a partir de agora.
        campos["unidade_aberta_em"] = _agora().isoformat()
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
    if body.codigo_barras is not None:
        _validar_codigo_barras_livre(supabase, user_id, body.codigo_barras, ignorar_item_id=item_id)
        campos["codigo_barras"] = body.codigo_barras
    if body.modo_controle is not None:
        campos["modo_controle"] = body.modo_controle
        campos["duracao_dias"] = body.duracao_dias
        campos["duracao_atendimentos"] = body.duracao_atendimentos
        if body.modo_controle != "quantidade" and item_atual.get("modo_controle") != body.modo_controle:
            # Trocou para um modo por validade agora: reinicia a contagem
            # a partir de hoje, do mesmo jeito que uma entrada nova faz.
            campos["unidade_aberta_em"] = _agora().isoformat()
            campos["atendimentos_desde_abertura"] = 0
    if campos:
        supabase.table("estoque_itens").update(campos).eq("id", item_id).eq("user_id", user_id).execute()
    return _buscar_item(supabase, user_id, item_id)


def abrir_unidade(supabase: Client, user_id: str, item_id: str) -> dict:
    """
    Marca "abri uma unidade nova" sem passar por movimentação de entrada —
    caso citado pelo dono do projeto (06/09/2026): a Thamires pode abrir um
    pote/frasco que já tinha em estoque (não é compra nova), e hoje só a
    entrada reiniciava a contagem de dias/atendimentos (`criar_movimentacao`).
    Só faz sentido para item em modo de validade — em "quantidade" não existe
    "unidade aberta" para reiniciar.
    """
    item = _buscar_item(supabase, user_id, item_id)
    modo = item.get("modo_controle") or "quantidade"
    if modo == "quantidade":
        raise HTTPException(
            status_code=422,
            detail={
                "codigo": "VALIDACAO_INVALIDA",
                "mensagem": "Esse item não tem controle por validade — não há unidade para abrir.",
            },
        )
    supabase.table("estoque_itens").update({
        "unidade_aberta_em": _agora().isoformat(),
        "atendimentos_desde_abertura": 0,
    }).eq("id", item_id).eq("user_id", user_id).execute()
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

    modo = item.get("modo_controle") or "quantidade"
    if body.tipo == "entrada" and modo != "quantidade":
        # Comprar de novo = abrir uma unidade nova: reinicia a contagem de
        # dias/atendimentos, mesmo raciocínio de A6 (a compra é o gatilho).
        campos_item["unidade_aberta_em"] = _agora().isoformat()
        campos_item["atendimentos_desde_abertura"] = 0
    elif body.tipo == "saida" and modo == "validade_atendimentos":
        # Saída manual também conta como "usei num atendimento" — mesma
        # contagem que a finalização de atendimento incrementa direto pelo
        # RPC (`atendimentos_service.finalizar`).
        campos_item["atendimentos_desde_abertura"] = int(item.get("atendimentos_desde_abertura") or 0) + 1

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
        "id, item_id, tipo, quantidade, motivo, atendimento_id, criado_em"
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
            }
            for m in linhas
        ]
    }
