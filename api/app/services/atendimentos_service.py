from datetime import datetime, timezone

from fastapi import HTTPException
from supabase import Client

from app.core.supabase_client import rows, row
from app.schemas.atendimentos import AtendimentoBodyIn, FinalizarBodyIn


def _ajustar_estoque(supabase: Client, user_id: str, item_id: str, delta: float, permitir_negativo: bool) -> dict | None:
    """
    Ajusta o saldo de um item pelo RPC atômico `ajustar_estoque` (`update` com
    a conta e a trava no mesmo statement) — nunca por `select` seguido de
    `update` com o valor literal: entre os dois passos, outra finalização do
    mesmo item ao mesmo tempo escreveria por cima (dado perdido). Com
    `service_role`, `auth.uid()` não existe na sessão — por isso o RPC
    precisa de `p_user_id` explícito (006_ajustar_estoque_rpc_service_role.sql).
    Devolve `None` quando a trava impediu o update (saldo insuficiente e
    `permitir_negativo=False`).
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


def _resolver_servicos(supabase: Client, user_id: str, entradas: list) -> list[dict]:
    """Cada entrada vira {servico_id, nome, preco} — do catálogo ou avulso."""
    ids = [e.servico_id for e in entradas if e.servico_id]
    catalogo: dict[str, dict] = {}
    if ids:
        resp = (
            supabase.table("servicos")
            .select("id, nome, preco")
            .eq("user_id", user_id)
            .in_("id", ids)
            .execute()
        )
        catalogo = {s["id"]: s for s in rows(resp.data)}
        faltantes = [i for i in ids if i not in catalogo]
        if faltantes:
            raise HTTPException(
                status_code=422,
                detail={
                    "codigo": "VALIDACAO_INVALIDA",
                    "mensagem": "Serviço inválido para este salão",
                    "result": {"servico_ids": faltantes},
                },
            )

    resolvidos = []
    for e in entradas:
        if e.servico_id:
            s = catalogo[e.servico_id]
            resolvidos.append({"servico_id": s["id"], "nome": s["nome"], "preco": s["preco"]})
        else:
            resolvidos.append({"servico_id": None, "nome": e.nome, "preco": e.preco})
    return resolvidos


def _buscar_atendimento(supabase: Client, user_id: str, atendimento_id: str) -> dict:
    resp = (
        supabase.table("atendimentos")
        .select("id, nome_cliente, telefone_cliente, data, status")
        .eq("user_id", user_id)
        .eq("id", atendimento_id)
        .execute()
    )
    linhas = rows(resp.data)
    if not linhas:
        raise HTTPException(
            status_code=404,
            detail={"codigo": "RECURSO_NAO_ENCONTRADO", "mensagem": "Atendimento não encontrado"},
        )
    return linhas[0]


def _estimar_custo_insumos_agendados(supabase: Client, user_id: str, servicos: list[dict]) -> float | None:
    """
    Prevê o custo de um atendimento ainda agendado com a composição atual do
    catálogo e o custo médio atual do estoque. Não grava nem baixa nada: na
    finalização, a usuária pode alterar a composição e o custo real é congelado.
    """
    if any(servico["servico_id"] is None for servico in servicos):
        return None

    ids_servico = list({servico["servico_id"] for servico in servicos})
    if not ids_servico:
        return 0.0

    resp_padrao = (
        supabase.table("servico_produtos_padrao")
        .select("servico_id, item_estoque_id, quantidade")
        .in_("servico_id", ids_servico)
        .execute()
    )
    produtos_por_servico: dict[str, list[dict]] = {}
    for produto in rows(resp_padrao.data):
        produtos_por_servico.setdefault(produto["servico_id"], []).append(produto)

    ids_item = list(
        {
            produto["item_estoque_id"]
            for produtos in produtos_por_servico.values()
            for produto in produtos
        }
    )
    if not ids_item:
        return 0.0

    resp_itens = (
        supabase.table("estoque_itens")
        .select("id, custo_medio")
        .eq("user_id", user_id)
        .in_("id", ids_item)
        .execute()
    )
    custo_por_item = {item["id"]: item["custo_medio"] for item in rows(resp_itens.data)}

    estimado = 0.0
    for servico in servicos:
        for produto in produtos_por_servico.get(servico["servico_id"], []):
            custo_unitario = custo_por_item.get(produto["item_estoque_id"])
            if custo_unitario is None:
                return None
            estimado += produto["quantidade"] * custo_unitario
    return estimado


def _montar_saida(supabase: Client, user_id: str, atendimento: dict) -> dict:
    aid = atendimento["id"]
    resp_serv = (
        supabase.table("atendimento_servicos")
        .select("servico_id, nome_servico, preco_snapshot")
        .eq("atendimento_id", aid)
        .execute()
    )
    resp_mat = (
        supabase.table("atendimento_insumos")
        .select("item_estoque_id, nome, quantidade, preco")
        .eq("atendimento_id", aid)
        .execute()
    )
    servicos = [
        {"servico_id": s["servico_id"], "nome": s["nome_servico"], "preco": s["preco_snapshot"]}
        for s in rows(resp_serv.data)
    ]
    materiais = [
        {
            "item_estoque_id": m["item_estoque_id"],
            "nome": m["nome"],
            "quantidade": m["quantidade"],
            "preco": m["preco"],
        }
        for m in rows(resp_mat.data)
    ]
    total_servicos = sum(s["preco"] for s in servicos)
    total_materiais = sum(m["preco"] * m["quantidade"] for m in materiais)
    custo_estimado = (
        _estimar_custo_insumos_agendados(supabase, user_id, servicos)
        if atendimento["status"] == "agendado"
        else None
    )
    return {
        "id": aid,
        "cliente_nome": atendimento["nome_cliente"],
        "cliente_telefone": atendimento.get("telefone_cliente") or None,
        "data": atendimento["data"],
        "status": atendimento["status"],
        "servicos": servicos,
        "materiais": materiais,
        "total_servicos": total_servicos,
        "total_materiais": total_materiais,
        "saldo": total_servicos - total_materiais,
        "custo_estimado": custo_estimado,
        "saldo_estimado": total_servicos - custo_estimado if custo_estimado is not None else None,
    }


def listar(
    supabase: Client, user_id: str, inicio: str, fim: str, status: list[str] | None
) -> dict:
    query = (
        supabase.table("atendimentos")
        .select("id, nome_cliente, telefone_cliente, data, status")
        .eq("user_id", user_id)
        .gte("data", f"{inicio}T00:00:00-03:00")
        .lte("data", f"{fim}T23:59:59-03:00")
        .order("data", desc=True)
    )
    if status:
        query = query.in_("status", status)
    linhas = rows(query.execute().data)

    atendimentos = [_montar_saida(supabase, user_id, a) for a in linhas]
    saldo_liquido = sum(a["saldo"] for a in atendimentos if a["status"] != "cancelado")
    return {
        "saldo_liquido": saldo_liquido,
        "quantidade": len(atendimentos),
        "atendimentos": atendimentos,
    }


def obter(supabase: Client, user_id: str, atendimento_id: str) -> dict:
    atendimento = _buscar_atendimento(supabase, user_id, atendimento_id)
    return _montar_saida(supabase, user_id, atendimento)


def criar(supabase: Client, user_id: str, body: AtendimentoBodyIn) -> dict:
    servicos = _resolver_servicos(supabase, user_id, body.servicos)

    resp = (
        supabase.table("atendimentos")
        .insert({
            "user_id": user_id,
            "nome_cliente": body.cliente_nome,
            "telefone_cliente": body.cliente_telefone or "",
            "data": body.data.isoformat(),
            "status": "agendado",
            "origem": "interno",
        })
        .execute()
    )
    atendimento = row(resp.data)

    linhas_servico = [
        {
            "atendimento_id": atendimento["id"],
            "servico_id": s["servico_id"],
            "nome_servico": s["nome"],
            "preco_snapshot": s["preco"],
        }
        for s in servicos
    ]
    supabase.table("atendimento_servicos").insert(linhas_servico).execute()

    return _montar_saida(supabase, user_id, atendimento)


def editar(supabase: Client, user_id: str, atendimento_id: str, body: AtendimentoBodyIn) -> dict:
    atendimento = _buscar_atendimento(supabase, user_id, atendimento_id)
    if atendimento["status"] == "cancelado":
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ATENDIMENTO_STATUS_INVALIDO",
                "mensagem": "Atendimento cancelado não pode ser editado",
            },
        )

    servicos = _resolver_servicos(supabase, user_id, body.servicos)

    supabase.table("atendimentos").update({
        "nome_cliente": body.cliente_nome,
        "telefone_cliente": body.cliente_telefone or "",
        "data": body.data.isoformat(),
    }).eq("id", atendimento_id).execute()

    supabase.table("atendimento_servicos").delete().eq("atendimento_id", atendimento_id).execute()
    linhas_servico = [
        {
            "atendimento_id": atendimento_id,
            "servico_id": s["servico_id"],
            "nome_servico": s["nome"],
            "preco_snapshot": s["preco"],
        }
        for s in servicos
    ]
    supabase.table("atendimento_servicos").insert(linhas_servico).execute()

    return obter(supabase, user_id, atendimento_id)


def finalizar(
    supabase: Client, user_id: str, atendimento_id: str, body: FinalizarBodyIn
) -> dict:
    atendimento = _buscar_atendimento(supabase, user_id, atendimento_id)
    if atendimento["status"] != "agendado":
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ATENDIMENTO_STATUS_INVALIDO",
                "mensagem": "Só é possível finalizar um atendimento agendado",
            },
        )

    ids_estoque = [m.item_estoque_id for m in body.materiais if m.item_estoque_id]
    itens_estoque: dict[str, dict] = {}
    if ids_estoque:
        resp = (
            supabase.table("estoque_itens")
            .select(
                "id, nome, unidade, quantidade_atual, custo_medio, modo_controle, atendimentos_desde_abertura"
            )
            .eq("user_id", user_id)
            .in_("id", ids_estoque)
            .execute()
        )
        itens_estoque = {i["id"]: i for i in rows(resp.data)}
        faltantes_cadastro = [i for i in ids_estoque if i not in itens_estoque]
        if faltantes_cadastro:
            raise HTTPException(
                status_code=422,
                detail={
                    "codigo": "VALIDACAO_INVALIDA",
                    "mensagem": "Item de estoque inválido para este salão",
                    "result": {"item_estoque_ids": faltantes_cadastro},
                },
            )

    faltantes = []
    for m in body.materiais:
        if not m.item_estoque_id:
            continue
        item = itens_estoque[m.item_estoque_id]
        disponivel = item["quantidade_atual"]
        if disponivel < m.quantidade:
            faltantes.append({
                "item_estoque_id": item["id"],
                "nome": item["nome"],
                "unidade": item["unidade"],
                "quantidade_solicitada": m.quantidade,
                "quantidade_disponivel": disponivel,
                "deficit": m.quantidade - disponivel,
            })

    if faltantes and not body.confirmar_estoque_insuficiente:
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ESTOQUE_INSUFICIENTE",
                "mensagem": "Alguns materiais estão sem saldo em estoque.",
                "result": {"faltantes": faltantes},
            },
        )

    itens_com_deficit = {f["item_estoque_id"] for f in faltantes}

    # Soma por item — a mesma composição pode aparecer em mais de uma linha,
    # e o RPC ajusta o saldo uma vez por item, não uma vez por linha.
    pedidos: dict[str, float] = {}
    for m in body.materiais:
        if m.item_estoque_id:
            pedidos[m.item_estoque_id] = pedidos.get(m.item_estoque_id, 0) + m.quantidade

    # Decremento atômico primeiro — se a corrida com outra finalização
    # simultânea fizer a trava disparar (saldo mudou entre a leitura acima e
    # agora), desfaz os que já tinham sido decrementados nesta chamada e
    # devolve estoque insuficiente com números atualizados, em vez de deixar
    # o atendimento gravado com baixa parcial (mesma lógica de
    # `AtendimentosApi.finalizar` no frontend).
    decrementados: list[tuple[str, float]] = []
    for item_id, quantidade in pedidos.items():
        resultado = _ajustar_estoque(supabase, user_id, item_id, -quantidade, body.confirmar_estoque_insuficiente)
        if resultado is None:
            for d_item_id, d_quantidade in decrementados:
                _ajustar_estoque(supabase, user_id, d_item_id, d_quantidade, True)
            item = itens_estoque[item_id]
            resp_atual = (
                supabase.table("estoque_itens")
                .select("quantidade_atual")
                .eq("id", item_id)
                .execute()
            )
            atual = row(resp_atual.data)
            disponivel = atual.get("quantidade_atual", item["quantidade_atual"]) if atual else item["quantidade_atual"]
            raise HTTPException(
                status_code=409,
                detail={
                    "codigo": "ESTOQUE_INSUFICIENTE",
                    "mensagem": "Alguns materiais estão sem saldo em estoque.",
                    "result": {
                        "faltantes": [{
                            "item_estoque_id": item["id"],
                            "nome": item["nome"],
                            "unidade": item["unidade"],
                            "quantidade_solicitada": quantidade,
                            "quantidade_disponivel": disponivel,
                            "deficit": quantidade - disponivel,
                        }]
                    },
                },
            )
        decrementados.append((item_id, quantidade))

    # Item no modo "validade_atendimentos" (008_estoque_validade_e_catalogo.sql):
    # cada atendimento consumido conta como um uso da unidade aberta, pra
    # avisar quando ela estiver perto de acabar por atendimentos, não só por
    # saldo. Uma vez por item por finalização, não uma vez por quantidade.
    for item_id, _ in decrementados:
        item = itens_estoque[item_id]
        if item.get("modo_controle") == "validade_atendimentos":
            supabase.table("estoque_itens").update({
                "atendimentos_desde_abertura": int(item.get("atendimentos_desde_abertura") or 0) + 1,
            }).eq("id", item_id).eq("user_id", user_id).execute()

    linhas_insumo = []
    for m in body.materiais:
        if m.item_estoque_id:
            item = itens_estoque[m.item_estoque_id]
            linhas_insumo.append({
                "atendimento_id": atendimento_id,
                "item_estoque_id": item["id"],
                "nome": item["nome"],
                "quantidade": m.quantidade,
                "preco": item["custo_medio"],
            })
        else:
            linhas_insumo.append({
                "atendimento_id": atendimento_id,
                "item_estoque_id": None,
                "nome": m.nome,
                "quantidade": m.quantidade,
                "preco": m.preco,
            })
    if linhas_insumo:
        supabase.table("atendimento_insumos").insert(linhas_insumo).execute()

    for item_id, quantidade in pedidos.items():
        item = itens_estoque[item_id]
        supabase.table("estoque_movimentacoes").insert({
            "user_id": user_id,
            "item_id": item["id"],
            "tipo": "saida",
            "quantidade": quantidade,
            "motivo": "Consumo em atendimento",
            "custo_unitario": item["custo_medio"],
            "atendimento_id": atendimento_id,
            "forcada": item["id"] in itens_com_deficit,
        }).execute()

    # custo_insumos_snapshot: composição padrão (produtos_padrao) × custo_medio
    # no momento do fechamento — congela o custo do serviço para o resumo,
    # independente do que foi de fato consumido acima (§4/§8).
    resp_serv = (
        supabase.table("atendimento_servicos")
        .select("id, servico_id")
        .eq("atendimento_id", atendimento_id)
        .execute()
    )
    for s in rows(resp_serv.data):
        if not s["servico_id"]:
            continue
        resp_padrao = (
            supabase.table("servico_produtos_padrao")
            .select("item_estoque_id, quantidade")
            .eq("servico_id", s["servico_id"])
            .execute()
        )
        padrao = rows(resp_padrao.data)
        if not padrao:
            continue
        ids_padrao = [p["item_estoque_id"] for p in padrao]
        resp_custos = (
            supabase.table("estoque_itens").select("id, custo_medio").in_("id", ids_padrao).execute()
        )
        custos = {i["id"]: i["custo_medio"] for i in rows(resp_custos.data)}
        custo_total = sum(p["quantidade"] * custos.get(p["item_estoque_id"], 0) for p in padrao)
        supabase.table("atendimento_servicos").update({
            "custo_insumos_snapshot": custo_total,
        }).eq("id", s["id"]).execute()

    if faltantes:
        for f in faltantes:
            supabase.table("alertas").insert({
                "user_id": user_id,
                "tipo": "estoque_negativo",
                "severidade": "alerta",
                "titulo": f"Estoque negativo: {f['nome']}",
                "mensagem": f"{f['nome']} ficou com saldo negativo após o atendimento",
                "referencia_tipo": "estoque_item",
                "referencia_id": f["item_estoque_id"],
                "chave_dedupe": f"estoque_negativo:{f['item_estoque_id']}:{atendimento_id}",
            }).execute()

    supabase.table("atendimentos").update({
        "status": "finalizado",
        "finalizado_em": datetime.now(timezone.utc).isoformat(),
    }).eq("id", atendimento_id).execute()

    return obter(supabase, user_id, atendimento_id)


def cancelar(supabase: Client, user_id: str, atendimento_id: str) -> dict:
    atendimento = _buscar_atendimento(supabase, user_id, atendimento_id)
    if atendimento["status"] == "cancelado":
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ATENDIMENTO_STATUS_INVALIDO",
                "mensagem": "Atendimento já está cancelado",
            },
        )

    if atendimento["status"] == "finalizado":
        resp_mov = (
            supabase.table("estoque_movimentacoes")
            .select("item_id, quantidade")
            .eq("atendimento_id", atendimento_id)
            .eq("tipo", "saida")
            .execute()
        )
        for mov in rows(resp_mov.data):
            # Estorno sempre cabe (devolve saldo) — não precisa da trava de A5,
            # por isso `permitir_negativo=True` sempre (mesma lógica de
            # `AtendimentosApi.cancelar` no frontend). Ajuste atômico pelo RPC,
            # não leitura-depois-escrita: duas devoluções ao mesmo item ao mesmo
            # tempo (ex.: cancelar dois atendimentos que usaram o mesmo insumo)
            # não podem se sobrescrever.
            resultado = _ajustar_estoque(supabase, user_id, mov["item_id"], mov["quantidade"], True)
            if resultado is None:
                continue
            supabase.table("estoque_movimentacoes").insert({
                "user_id": user_id,
                "item_id": mov["item_id"],
                "tipo": "ajuste",
                "quantidade": mov["quantidade"],
                "motivo": "Estorno — atendimento cancelado",
                "atendimento_id": atendimento_id,
                "forcada": False,
            }).execute()

    supabase.table("atendimentos").update({
        "status": "cancelado",
        "cancelado_em": datetime.now(timezone.utc).isoformat(),
    }).eq("id", atendimento_id).execute()

    return obter(supabase, user_id, atendimento_id)


def excluir(supabase: Client, user_id: str, atendimento_id: str) -> None:
    atendimento = _buscar_atendimento(supabase, user_id, atendimento_id)
    if atendimento["status"] != "agendado":
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ATENDIMENTO_STATUS_INVALIDO",
                "mensagem": "Só é possível excluir um atendimento agendado",
            },
        )
    supabase.table("atendimentos").delete().eq("id", atendimento_id).execute()

