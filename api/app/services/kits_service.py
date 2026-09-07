"""Regras de `kits` (endpoints-backend.md §6, A7).

Kit de revenda: montado a partir do estoque que ela já tem, vendido avulso,
fora do atendimento. `GET /kits` é o cadastro (a receita); montar e vender são
dois fatos separados — ela monta cinco kits numa tarde e vende ao longo das
semanas seguintes, por isso o kit tem saldo próprio (`quantidade_montada`).

    estoque de insumos ──montar──▶ kits montados ──vender──▶ receita

`montar` segue a mesma mecânica de duas passadas do A5 (finalizar
atendimento): sem saldo de insumo, 409 ESTOQUE_INSUFICIENTE sem gravar nada;
confirmando, monta e deixa o saldo do insumo negativo. `vender` **não** tem
segunda passada (A7): vender mais do que está montado é 409 KIT_NAO_MONTADO,
definitivo — não existe "vender um kit que não existe".
"""

from datetime import datetime, timezone

from fastapi import HTTPException
from supabase import Client

from app.core.supabase_client import row, rows
from app.schemas.kits import KitIn, KitPatchIn, MontarKitIn, VenderKitIn

_CAMPOS_KIT = "id, nome, preco_venda, quantidade_montada, ativo"


def _ajustar_estoque(supabase: Client, user_id: str, item_id: str, delta: float, permitir_negativo: bool) -> dict | None:
    """
    Mesmo RPC atômico de `atendimentos_service`/`estoque_service` — montar kit
    também é uma baixa de estoque, e não pode ser leitura-depois-escrita pelo
    mesmo motivo (duas montagens/baixas do mesmo insumo ao mesmo tempo se
    sobrescreveriam). `p_user_id` explícito porque quem chama é o
    `service_role` (006_ajustar_estoque_rpc_service_role.sql).
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


def _buscar_kit(supabase: Client, user_id: str, kit_id: str) -> dict:
    resp = (
        supabase.table("kits")
        .select(_CAMPOS_KIT)
        .eq("user_id", user_id)
        .eq("id", kit_id)
        .execute()
    )
    linhas = rows(resp.data)
    if not linhas:
        raise HTTPException(
            status_code=404,
            detail={"codigo": "RECURSO_NAO_ENCONTRADO", "mensagem": "Kit não encontrado"},
        )
    return linhas[0]


def _carregar_composicoes(supabase: Client, kit_ids: list[str]) -> dict[str, list[dict]]:
    """kit_id -> [{item_estoque_id, quantidade}] — sem custo/saldo (ver `_carregar_saldos`)."""
    if not kit_ids:
        return {}
    resp = (
        supabase.table("kit_itens")
        .select("kit_id, item_estoque_id, quantidade")
        .in_("kit_id", kit_ids)
        .execute()
    )
    composicoes: dict[str, list[dict]] = {}
    for linha in rows(resp.data):
        composicoes.setdefault(str(linha["kit_id"]), []).append({
            "item_estoque_id": str(linha["item_estoque_id"]),
            "quantidade": float(linha["quantidade"]),
        })
    return composicoes


def _carregar_saldos(supabase: Client, item_ids: list[str]) -> dict[str, dict]:
    """item_estoque_id -> {nome, unidade, quantidade_atual, custo_medio, modo_controle, atendimentos_desde_abertura}."""
    if not item_ids:
        return {}
    resp = (
        supabase.table("estoque_itens")
        .select("id, nome, unidade, quantidade_atual, custo_medio, modo_controle, atendimentos_desde_abertura")
        .in_("id", item_ids)
        .execute()
    )
    return {str(i["id"]): i for i in rows(resp.data)}


def _kit_out(kit: dict, itens_composicao: list[dict], saldos: dict[str, dict]) -> dict:
    """Todo campo derivado é calculado aqui, nunca lido do banco (endpoints-backend.md §6)."""
    custo_total = sum(
        i["quantidade"] * float(saldos.get(i["item_estoque_id"], {}).get("custo_medio", 0))
        for i in itens_composicao
    )
    if not itens_composicao:
        quantidade_montavel = 0.0
    else:
        quantidade_montavel = min(
            float(saldos.get(i["item_estoque_id"], {}).get("quantidade_atual", 0)) // i["quantidade"]
            if i["quantidade"] else 0.0
            for i in itens_composicao
        )
        quantidade_montavel = max(0.0, quantidade_montavel)
    quantidade_montada = float(kit["quantidade_montada"])
    preco_venda = float(kit["preco_venda"])

    return {
        "id": str(kit["id"]),
        "nome": kit["nome"],
        "preco_venda": preco_venda,
        "custo_total": custo_total,
        "margem": preco_venda - custo_total,
        "quantidade_montada": quantidade_montada,
        "quantidade_montavel": quantidade_montavel,
        "disponivel": quantidade_montada > 0 or quantidade_montavel > 0,
        "itens": [
            {
                "item_estoque_id": i["item_estoque_id"],
                "nome": saldos.get(i["item_estoque_id"], {}).get("nome", ""),
                "quantidade": i["quantidade"],
                "unidade": saldos.get(i["item_estoque_id"], {}).get("unidade", "un"),
            }
            for i in itens_composicao
        ],
    }


def listar(supabase: Client, user_id: str) -> dict:
    resp = (
        supabase.table("kits")
        .select(_CAMPOS_KIT)
        .eq("user_id", user_id)
        .eq("ativo", True)
        .order("nome")
        .execute()
    )
    kits = rows(resp.data)
    kit_ids = [str(k["id"]) for k in kits]
    composicoes = _carregar_composicoes(supabase, kit_ids)
    ids_item = list({i["item_estoque_id"] for lista in composicoes.values() for i in lista})
    saldos = _carregar_saldos(supabase, ids_item)

    return {
        "kits": [_kit_out(k, composicoes.get(str(k["id"]), []), saldos) for k in kits]
    }


def obter(supabase: Client, user_id: str, kit_id: str) -> dict:
    kit = _buscar_kit(supabase, user_id, kit_id)
    composicoes = _carregar_composicoes(supabase, [kit_id])
    itens = composicoes.get(kit_id, [])
    saldos = _carregar_saldos(supabase, [i["item_estoque_id"] for i in itens])
    return _kit_out(kit, itens, saldos)


def criar(supabase: Client, user_id: str, body: KitIn) -> dict:
    resp = (
        supabase.table("kits")
        .insert({
            "user_id": user_id,
            "nome": body.nome,
            "preco_venda": body.preco_venda,
            "quantidade_montada": 0,
            "ativo": True,
        })
        .execute()
    )
    kit = row(resp.data)
    kit_id = str(kit["id"])

    if body.itens:
        linhas = [
            {"kit_id": kit_id, "item_estoque_id": i.item_estoque_id, "quantidade": i.quantidade}
            for i in body.itens
        ]
        supabase.table("kit_itens").insert(linhas).execute()

    return obter(supabase, user_id, kit_id)


def editar(supabase: Client, user_id: str, kit_id: str, body: KitPatchIn) -> dict:
    _buscar_kit(supabase, user_id, kit_id)

    campos = {}
    if body.nome is not None:
        campos["nome"] = body.nome
    if body.preco_venda is not None:
        campos["preco_venda"] = body.preco_venda
    if campos:
        supabase.table("kits").update(campos).eq("id", kit_id).eq("user_id", user_id).execute()

    if body.itens is not None:
        supabase.table("kit_itens").delete().eq("kit_id", kit_id).execute()
        if body.itens:
            linhas = [
                {"kit_id": kit_id, "item_estoque_id": i.item_estoque_id, "quantidade": i.quantidade}
                for i in body.itens
            ]
            supabase.table("kit_itens").insert(linhas).execute()

    return obter(supabase, user_id, kit_id)


def excluir(supabase: Client, user_id: str, kit_id: str) -> None:
    """Soft delete (`ativo=false`) se o kit já tem venda ou montagem — apagar quebraria o histórico."""
    kit = _buscar_kit(supabase, user_id, kit_id)

    resp_vendas = (
        supabase.table("kit_vendas").select("id").eq("kit_id", kit_id).limit(1).execute()
    )
    ja_teve_movimento = bool(rows(resp_vendas.data)) or float(kit["quantidade_montada"]) > 0

    if ja_teve_movimento:
        supabase.table("kits").update({"ativo": False}).eq("id", kit_id).eq("user_id", user_id).execute()
    else:
        supabase.table("kit_itens").delete().eq("kit_id", kit_id).execute()
        supabase.table("kits").delete().eq("id", kit_id).eq("user_id", user_id).execute()


def montar(supabase: Client, user_id: str, kit_id: str, body: MontarKitIn) -> dict:
    _buscar_kit(supabase, user_id, kit_id)

    composicao = _carregar_composicoes(supabase, [kit_id]).get(kit_id, [])
    if not composicao:
        raise HTTPException(
            status_code=422,
            detail={"codigo": "VALIDACAO_INVALIDA", "mensagem": "Kit sem composição cadastrada."},
        )

    ids_item = [c["item_estoque_id"] for c in composicao]
    saldos = _carregar_saldos(supabase, ids_item)

    faltantes = []
    for c in composicao:
        necessario = c["quantidade"] * body.quantidade
        item = saldos[c["item_estoque_id"]]
        disponivel = float(item["quantidade_atual"])
        if disponivel < necessario:
            faltantes.append({
                "item_estoque_id": c["item_estoque_id"],
                "nome": item["nome"],
                "unidade": item["unidade"],
                "quantidade_solicitada": necessario,
                "quantidade_disponivel": disponivel,
                "deficit": necessario - disponivel,
            })

    if faltantes and not body.confirmar_estoque_insuficiente:
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "ESTOQUE_INSUFICIENTE",
                "mensagem": "Alguns insumos estão sem saldo em estoque.",
                "result": {"faltantes": faltantes},
            },
        )

    itens_com_deficit = {f["item_estoque_id"] for f in faltantes}

    # Decremento atômico primeiro — operação só é gravada como sucesso se
    # todos os itens da composição forem baixados; senão desfaz o que já
    # tinha decrementado nesta chamada (mesmo padrão de
    # `atendimentos_service.finalizar`/`AtendimentosApi.finalizar`).
    decrementados: list[tuple[str, float]] = []
    for c in composicao:
        item_id = c["item_estoque_id"]
        necessario = c["quantidade"] * body.quantidade
        resultado = _ajustar_estoque(supabase, user_id, item_id, -necessario, body.confirmar_estoque_insuficiente)
        if resultado is None:
            for d_item_id, d_quantidade in decrementados:
                _ajustar_estoque(supabase, user_id, d_item_id, d_quantidade, True)
            item = saldos[item_id]
            resp_atual = supabase.table("estoque_itens").select("quantidade_atual").eq("id", item_id).execute()
            atual = row(resp_atual.data)
            disponivel = float(atual["quantidade_atual"]) if atual else float(item["quantidade_atual"])
            raise HTTPException(
                status_code=409,
                detail={
                    "codigo": "ESTOQUE_INSUFICIENTE",
                    "mensagem": "Alguns insumos estão sem saldo em estoque.",
                    "result": {
                        "faltantes": [{
                            "item_estoque_id": item_id,
                            "nome": item["nome"],
                            "unidade": item["unidade"],
                            "quantidade_solicitada": necessario,
                            "quantidade_disponivel": disponivel,
                            "deficit": necessario - disponivel,
                        }]
                    },
                },
            )
        decrementados.append((item_id, necessario))

    for c in composicao:
        item_id = c["item_estoque_id"]
        necessario = c["quantidade"] * body.quantidade
        item = saldos[item_id]
        supabase.table("estoque_movimentacoes").insert({
            "user_id": user_id,
            "item_id": item_id,
            "tipo": "saida",
            "quantidade": necessario,
            "motivo": "Montagem de kit",
            "custo_unitario": item["custo_medio"],
            "kit_id": kit_id,
            "forcada": item_id in itens_com_deficit,
        }).execute()
        if (item.get("modo_controle") or "quantidade") == "validade_atendimentos":
            # Montar kit também "usa" o frasco/pote aberto, do mesmo jeito que
            # `atendimentos_service.finalizar` incrementa direto — sem isso,
            # um insumo de validade por atendimento vendido só via kit nunca
            # contava as vezes de uso (gap conhecido, endpoints-backend.md §6).
            supabase.table("estoque_itens").update({
                "atendimentos_desde_abertura": int(item.get("atendimentos_desde_abertura") or 0) + int(body.quantidade),
            }).eq("id", item_id).eq("user_id", user_id).execute()

    # O saldo de insumo já passou pelo RPC atômico acima — o único ponto sem
    # trava de corrida é este `quantidade_montada += quantidade`. Não existe
    # hoje uma RPC dedicada para kit (só a de estoque); a janela de corrida
    # entre duas montagens do mesmo kit ao mesmo tempo é bem mais estreita que
    # a de estoque (mesma ressalva de `KitsApi.montar` no frontend).
    kit_atual = _buscar_kit(supabase, user_id, kit_id)
    supabase.table("kits").update({
        "quantidade_montada": float(kit_atual["quantidade_montada"]) + body.quantidade,
    }).eq("id", kit_id).eq("user_id", user_id).execute()

    return obter(supabase, user_id, kit_id)


def vender(supabase: Client, user_id: str, kit_id: str, body: VenderKitIn) -> dict:
    kit = _buscar_kit(supabase, user_id, kit_id)
    quantidade_montada = float(kit["quantidade_montada"])

    if quantidade_montada < body.quantidade:
        raise HTTPException(
            status_code=409,
            detail={
                "codigo": "KIT_NAO_MONTADO",
                "mensagem": "Não há kits montados suficientes para essa venda.",
                "result": {
                    "quantidade_montada": quantidade_montada,
                    "quantidade_solicitada": body.quantidade,
                },
            },
        )

    composicao = _carregar_composicoes(supabase, [kit_id]).get(kit_id, [])
    saldos = _carregar_saldos(supabase, [c["item_estoque_id"] for c in composicao])
    custo_total = sum(c["quantidade"] * float(saldos.get(c["item_estoque_id"], {}).get("custo_medio", 0)) for c in composicao)

    preco_unitario = body.preco_unitario if body.preco_unitario is not None else float(kit["preco_venda"])

    supabase.table("kits").update({
        "quantidade_montada": quantidade_montada - body.quantidade,
    }).eq("id", kit_id).eq("user_id", user_id).execute()

    supabase.table("kit_vendas").insert({
        "user_id": user_id,
        "kit_id": kit_id,
        "quantidade": body.quantidade,
        "nome_snapshot": kit["nome"],
        "preco_unitario": preco_unitario,
        "custo_snapshot": custo_total,
        "forma_pagamento": body.forma_pagamento,
        "data": body.data.isoformat() if body.data else datetime.now(timezone.utc).isoformat(),
    }).execute()

    return obter(supabase, user_id, kit_id)
