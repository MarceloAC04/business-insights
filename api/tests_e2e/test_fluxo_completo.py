"""
E2E real — roda contra o FastAPI local, que por sua vez fala com o projeto
Supabase REAL (o mesmo `.env` de sempre, sem separação dev/prod — decisão do
dono do projeto em 07/09/2026: testar no ambiente que já existe).

Usuária de teste: teste@salap.app / Salao@2026. Todo dado criado aqui vive só
sob o user_id dessa conta — isolado da conta real da Thamires por RLS/user_id,
nunca aparece no app dela. Nomes/valores usados são realistas de propósito
(pedido do dono do projeto), não "Teste 1"/"Teste 2".

Como rodar:
  1. Suba a API local apontando pro .env real:
       cd api && uvicorn app.main:app --port 8091
  2. python tests_e2e/test_fluxo_completo.py

Não é um teste pytest (não precisa mockar nada — é o oposto: bate na API de
verdade). Roda como script, imprime cada etapa e falha alto (AssertionError)
no primeiro problema.
"""

import os
import sys
import threading
import time
from datetime import date, datetime, timedelta

import httpx

BASE_URL = os.environ.get("E2E_BASE_URL", "http://127.0.0.1:8091/v1")
EMAIL = "teste@salap.app"
SENHA = "Salao@2026"

cliente = httpx.Client(base_url=BASE_URL, timeout=30)
TOKEN: str | None = None


def _headers():
    return {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}


def chamar(metodo: str, path: str, **kwargs):
    resp = cliente.request(metodo, path, headers={**_headers(), **kwargs.pop("headers", {})}, **kwargs)
    return resp


def passo(titulo: str):
    print(f"\n{'=' * 70}\n{titulo}\n{'=' * 70}")


def ok(descricao: str, condicao: bool, extra=""):
    marca = "OK " if condicao else "FALHOU"
    print(f"  [{marca}] {descricao} {extra}")
    assert condicao, f"Falhou: {descricao} {extra}"


# ────────────────────────────────────────────────────────────────────
# 0. Garantir que a usuária de teste existe no Supabase Auth
# ────────────────────────────────────────────────────────────────────

def garantir_usuaria_teste():
    """Cria a conta teste@salap.app via Admin API do Supabase se ainda não
    existir. Precisa do service_role key (mesmo .env que a API usa) — não
    passa pelo FastAPI porque não existe endpoint de cadastro (só login)."""
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    service_key = os.environ["SUPABASE_SERVICE_KEY"]
    admin = create_client(url, service_key)

    # tenta achar por e-mail entre os usuários existentes
    pagina = admin.auth.admin.list_users()
    usuarios = pagina if isinstance(pagina, list) else getattr(pagina, "users", pagina)
    existente = next((u for u in usuarios if getattr(u, "email", None) == EMAIL), None)
    if existente:
        print(f"  usuária de teste já existe (id={existente.id})")
        return

    criado = admin.auth.admin.create_user({
        "email": EMAIL,
        "password": SENHA,
        "email_confirm": True,
        "user_metadata": {"nome": "Conta de Teste E2E"},
    })
    print(f"  usuária de teste criada (id={criado.user.id})")


# ────────────────────────────────────────────────────────────────────
# 1. Login
# ────────────────────────────────────────────────────────────────────

def testar_login():
    global TOKEN
    resp = chamar("POST", "/auth/login", json={"email": EMAIL, "senha": SENHA})
    ok("login responde 200", resp.status_code == 200, resp.text[:300])
    dados = resp.json()["result"]
    TOKEN = dados["token"]
    ok("token recebido", bool(TOKEN))
    return dados


# ────────────────────────────────────────────────────────────────────
# 2. Perfil, expediente e serviços (setup do salão de teste)
# ────────────────────────────────────────────────────────────────────

def configurar_perfil():
    resp = chamar("PUT", "/perfil", json={
        "nome": "Espaço Beleza & Cia (conta de teste E2E)",
        "proprietaria": "Conta de Teste",
        "telefone_whatsapp": "11999990000",
        "meta_faturamento_mensal": 8000.0,
    })
    ok("PUT /perfil", resp.status_code == 200, resp.text[:300])

    # expediente: seg-sex 09:00-18:00, sáb 09:00-13:00, dom fechado
    horarios = [
        {"dia_semana": 0, "ativo": False, "hora_inicio": None, "hora_fim": None},
        {"dia_semana": 1, "ativo": True, "hora_inicio": "09:00", "hora_fim": "18:00"},
        {"dia_semana": 2, "ativo": True, "hora_inicio": "09:00", "hora_fim": "18:00"},
        {"dia_semana": 3, "ativo": True, "hora_inicio": "09:00", "hora_fim": "18:00"},
        {"dia_semana": 4, "ativo": True, "hora_inicio": "09:00", "hora_fim": "18:00"},
        {"dia_semana": 5, "ativo": True, "hora_inicio": "09:00", "hora_fim": "18:00"},
        {"dia_semana": 6, "ativo": True, "hora_inicio": "09:00", "hora_fim": "13:00"},
    ]
    resp = chamar("PUT", "/perfil/horario-funcionamento", json={"horarios": horarios})
    ok("PUT /perfil/horario-funcionamento", resp.status_code == 200, resp.text[:300])

    resp = chamar("GET", "/perfil/link-agendamento")
    ok("GET /perfil/link-agendamento", resp.status_code == 200, resp.text[:300])
    slug = resp.json()["result"]["slug"]
    print(f"  slug do salão de teste: {slug}")
    return slug


def configurar_servicos():
    servicos_desejados = [
        {"nome": "Extensão de cílios", "preco": 180.0, "duracao_minutos": 120},
        {"nome": "Design de sobrancelha", "preco": 60.0, "duracao_minutos": 30},
        {"nome": "Limpeza de pele", "preco": 150.0, "duracao_minutos": 60},
    ]
    resp = chamar("GET", "/servicos")
    existentes = {s["nome"]: s for s in resp.json()["result"]["servicos"]}

    ids = {}
    for desejado in servicos_desejados:
        if desejado["nome"] in existentes:
            ids[desejado["nome"]] = existentes[desejado["nome"]]["id"]
            continue
        resp = chamar("POST", "/servicos", json=desejado)
        ok(f"POST /servicos ({desejado['nome']})", resp.status_code == 200, resp.text[:300])
        ids[desejado["nome"]] = resp.json()["result"]["id"]
    return ids


# ────────────────────────────────────────────────────────────────────
# 3. Geração de atendimentos em dois meses diferentes (pro resumo)
# ────────────────────────────────────────────────────────────────────

CLIENTES = [
    ("Ana Paula Ferreira", "11987654321"),
    ("Beatriz Souza Lima", "11976543210"),
    ("Camila Rodrigues", "11965432109"),
    ("Daniela Martins", "11954321098"),
]


def gerar_atendimentos(servico_ids: dict, ano: int, mes: int, quantidade: int):
    ext_id = servico_ids["Extensão de cílios"]
    criados = []
    for i in range(quantidade):
        cliente_nome, telefone = CLIENTES[i % len(CLIENTES)]
        dia = min(5 + i * 3, 27)
        data_hora = datetime(ano, mes, dia, 10, 0)
        resp = chamar("POST", "/atendimentos", json={
            "cliente_nome": cliente_nome,
            "cliente_telefone": telefone,
            "data": data_hora.isoformat(),
            "servicos": [{"servico_id": ext_id}],
        })
        ok(f"POST /atendimentos {cliente_nome} ({ano}-{mes:02d}-{dia:02d})",
           resp.status_code == 200, resp.text[:300])
        atendimento = resp.json()["result"]
        criados.append(atendimento)

        # finaliza sem materiais extras (dá baixa no estoque padrão do serviço)
        resp = chamar("PATCH", f"/atendimentos/{atendimento['id']}/finalizar", json={
            "materiais": [],
            "confirmar_estoque_insuficiente": True,
        })
        ok(f"finalizar atendimento {cliente_nome}", resp.status_code == 200, resp.text[:300])
    return criados


# ────────────────────────────────────────────────────────────────────
# 4. Resumo mensal em dois meses diferentes
# ────────────────────────────────────────────────────────────────────

def testar_resumo(ano: int, mes: int):
    resp = chamar("GET", "/resumo/mensal", params={"ano": ano, "mes": mes})
    ok(f"GET /resumo/mensal {ano}-{mes:02d}", resp.status_code == 200, resp.text[:300])
    dados = resp.json()["result"]
    print(f"  saldo do mês {ano}-{mes:02d}: {dados.get('saldo_liquido', dados)}")
    return dados


# ────────────────────────────────────────────────────────────────────
# 5. Gastos (variável + fixo), um vencido de propósito p/ alerta
# ────────────────────────────────────────────────────────────────────

def testar_gastos():
    hoje = date.today()

    resp = chamar("POST", "/gastos", json={
        "nome": "Reposição de fios e cola (extensão de cílios)",
        "valor": 340.0,
        "prazo_pagamento": (hoje + timedelta(days=10)).isoformat(),
        "forma_pagamento": "pix",
        "categoria": "material",
    })
    ok("POST /gastos (pendente, futuro)", resp.status_code == 200, resp.text[:300])

    resp = chamar("POST", "/gastos", json={
        "nome": "Aluguel da sala — competência atrasada",
        "valor": 1200.0,
        "prazo_pagamento": (hoje - timedelta(days=3)).isoformat(),
        "forma_pagamento": "a_vista",
        "categoria": "fixo",
    })
    ok("POST /gastos (vencido, gera alerta)", resp.status_code == 200, resp.text[:300])
    gasto_vencido = resp.json()["result"]

    resp = chamar("PATCH", f"/gastos/{gasto_vencido['id']}/pagar", json={})
    ok("PATCH /gastos/{id}/pagar", resp.status_code == 200, resp.text[:300])

    resp = chamar("GET", "/gastos", params={"ano": hoje.year, "mes": hoje.month})
    ok("GET /gastos do mês", resp.status_code == 200, resp.text[:300])


# ────────────────────────────────────────────────────────────────────
# 6. Alertas — confere que a central lista algo
# ────────────────────────────────────────────────────────────────────

def testar_alertas():
    resp = chamar("GET", "/alertas")
    ok("GET /alertas", resp.status_code == 200, resp.text[:300])
    dados = resp.json()["result"]
    print(f"  alertas ativos: {len(dados.get('alertas', []))}")
    return dados


# ────────────────────────────────────────────────────────────────────
# 7. Agendamento público — duplo agendamento simultâneo no mesmo horário
# ────────────────────────────────────────────────────────────────────

def testar_double_booking(slug: str, servico_ids: dict):
    design_id = servico_ids["Design de sobrancelha"]

    # Escolhe um dia distante (5 semanas) pra não colidir com as datas fixas
    # (5/8/11/14) usadas por gerar_atendimentos, e confirma no próprio endpoint
    # de disponibilidade qual horário está de fato livre antes de disparar a
    # concorrência — um horário calculado às cegas (ex. sempre 11:00, ou por
    # minuto/segundo atual) pode cair dentro de um atendimento que já ocupa a
    # agenda (interno ou de uma execução anterior do script, já que os dados de
    # teste não são limpos entre rodadas), e as duas tentativas simultâneas
    # cairiam em HORARIO_INDISPONIVEL por já estar genuinamente ocupado — não
    # por falha da trava de concorrência, que é o que este teste quer provar.
    hoje = date.today()
    dias_ate_terca = (1 - hoje.weekday()) % 7 or 7
    dia_alvo = hoje + timedelta(days=dias_ate_terca + 35)

    resp = chamar("GET", f"/agendamento-publico/{slug}/horarios-disponiveis", params={
        "data": dia_alvo.isoformat(),
        "servico_ids": design_id,
    })
    ok("GET horarios-disponiveis (dia de teste da concorrência)", resp.status_code == 200, resp.text[:300])
    horarios_livres = resp.json()["result"]["horarios"]
    ok("há horário livre no dia escolhido p/ testar concorrência", len(horarios_livres) > 0, f"(recebido: {horarios_livres})")
    horario_alvo = datetime.fromisoformat(f"{dia_alvo.isoformat()}T{horarios_livres[0]}")

    resultados = [None, None]

    def _agendar(indice: int, nome_cliente: str):
        resp = httpx.post(
            f"{BASE_URL}/agendamento-publico/{slug}/agendar",
            json={
                "cliente_nome": nome_cliente,
                "cliente_telefone": "11999998888",
                # offset -03:00 explícito (Brasília): sem ele, o texto naive vira
                # UTC ao ser convertido pra timestamptz no Postgres, deslocando o
                # horário em 3h e caindo fora do expediente — exatamente como o
                # frontend real já monta em routes/agendar.$slug.tsx
                # (`${data}T${horario}:00-03:00`); ver AgendarRequest/RPC agendar.
                "data": horario_alvo.strftime("%Y-%m-%dT%H:%M:%S") + "-03:00",
                "servicos": [{"servico_id": design_id}],
            },
            timeout=30,
        )
        resultados[indice] = resp

    t1 = threading.Thread(target=_agendar, args=(0, "Elisa Cardoso"))
    t2 = threading.Thread(target=_agendar, args=(1, "Fernanda Alves"))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    codigos = sorted(r.status_code for r in resultados)
    print(f"  status das duas tentativas simultâneas: {codigos}")
    ok(
        "exatamente uma das duas tentativas simultâneas é aceita",
        codigos == [200, 409] or codigos == [200, 400] or codigos == [200, 422],
        f"(recebido: {codigos}, corpo do rejeitado: "
        f"{[r.text[:200] for r in resultados if r.status_code != 200]})",
    )


# ────────────────────────────────────────────────────────────────────
# 8. Agendamento público — fora do expediente deve ser rejeitado
# ────────────────────────────────────────────────────────────────────

def testar_agendamento_fora_expediente(slug: str, servico_ids: dict):
    limpeza_id = servico_ids["Limpeza de pele"]

    hoje = date.today()
    dias_ate_domingo = (6 - hoje.weekday()) % 7 or 7
    domingo = hoje + timedelta(days=dias_ate_domingo)  # domingo é fechado no expediente configurado
    horario_alvo = datetime(domingo.year, domingo.month, domingo.day, 10, 0)

    resp = chamar("GET", f"/agendamento-publico/{slug}/horarios-disponiveis", params={
        "data": domingo.isoformat(),
        "servico_ids": limpeza_id,
    })
    ok("GET horarios-disponiveis (domingo fechado)", resp.status_code == 200, resp.text[:300])
    horarios = resp.json()["result"]["horarios"]
    ok("nenhum horário livre no dia fechado", horarios == [], f"(recebido: {horarios})")

    resp = httpx.post(
        f"{BASE_URL}/agendamento-publico/{slug}/agendar",
        json={
            "cliente_nome": "Gabriela Nunes",
            "cliente_telefone": "11988887777",
            "data": horario_alvo.strftime("%Y-%m-%dT%H:%M:%S") + "-03:00",
            "servicos": [{"servico_id": limpeza_id}],
        },
        timeout=30,
    )
    print(f"  status do agendamento fora do expediente: {resp.status_code}")
    ok("agendamento fora do expediente é rejeitado", resp.status_code >= 400, resp.text[:300])


# ────────────────────────────────────────────────────────────────────

def main():
    passo("0. Garantir usuária de teste")
    garantir_usuaria_teste()

    passo("1. Login")
    testar_login()

    passo("2. Perfil, expediente e serviços")
    slug = configurar_perfil()
    servico_ids = configurar_servicos()

    passo("3. Atendimentos — mês anterior")
    hoje = date.today()
    mes_anterior = hoje.month - 1 or 12
    ano_mes_anterior = hoje.year if hoje.month > 1 else hoje.year - 1
    gerar_atendimentos(servico_ids, ano_mes_anterior, mes_anterior, quantidade=3)

    passo("3b. Atendimentos — mês atual")
    gerar_atendimentos(servico_ids, hoje.year, hoje.month, quantidade=4)

    passo("4. Resumo mensal — comparando os dois meses")
    resumo_anterior = testar_resumo(ano_mes_anterior, mes_anterior)
    resumo_atual = testar_resumo(hoje.year, hoje.month)

    passo("5. Gastos")
    testar_gastos()

    passo("6. Alertas")
    testar_alertas()

    passo("7. Agendamento público — dois clientes no mesmo horário")
    testar_double_booking(slug, servico_ids)

    passo("8. Agendamento público — fora do expediente")
    testar_agendamento_fora_expediente(slug, servico_ids)

    passo("TUDO PASSOU")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"\n!!! TESTE FALHOU: {e}")
        sys.exit(1)
