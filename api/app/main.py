"""
Ponto de entrada da API do salão.

Responsabilidade desta camada:
  - Montar o app FastAPI com CORS, routers e metadata
  - Não conter nenhuma lógica de negócio

Divisão de trabalho:
  - React → FastAPI para toda operação autenticada
  - FastAPI → Supabase para persistência, regras de negócio e relatórios
  - Automações e notificações → n8n pelos webhooks desta API
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.schemas.envelope import registrar_exception_handlers
from app.routers import (
    auth,
    relatorio,
    precificacao,
    webhooks,
    health,
    perfil,
    agendamento_publico,
    atendimentos,
    servicos,
    estoque,
    kits,
    gastos,
    alertas,
)

cfg = get_settings()

app = FastAPI(
    title="Salon API",
    description=(
        "API operacional do app de gestão de salão: autenticação, cadastros, "
        "atendimentos, estoque, alertas e relatórios."
    ),
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── CORS ───────────────────────────────────────────────────────────
# Flutter (PWA) roda em origem diferente da API
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.cors_origins_list,
    # Túneis de teste (cloudflared/ngrok) em dev, pra testar do celular sem
    # precisar cadastrar cada subdomínio aleatório em CORS_ORIGINS.
    allow_origin_regex=None
    if cfg.is_production
    else r"https://.*\.(trycloudflare\.com|ngrok-free\.app|ngrok\.io)",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["*"],
)


@app.middleware("http")
async def impedir_cache_de_dados(request, call_next):
    """Dados autenticados não devem virar resposta 304 sem envelope."""
    response = await call_next(request)
    if request.url.path.startswith("/v1/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response

# ── Envelope de resposta ──────────────────────────────────────────
# HTTPException, erro de validação (422) e exceção genérica (500) — as três
# fontes possíveis de erro — passam a sair sempre como
# { total, mensagem, codigo, result }, nunca no formato padrão do FastAPI.
registrar_exception_handlers(app)

# ── Routers ────────────────────────────────────────────────────────
# Prefixo /v1 obrigatório (endpoints-backend.md §0 — base URL termina em /v1).
router_prefix = "/v1"
app.include_router(health.router, prefix=router_prefix)
app.include_router(auth.router, prefix=router_prefix)
app.include_router(relatorio.router, prefix=router_prefix)
app.include_router(precificacao.router, prefix=router_prefix)
app.include_router(webhooks.router, prefix=router_prefix)
app.include_router(perfil.router, prefix=router_prefix)
app.include_router(agendamento_publico.router, prefix=router_prefix)
app.include_router(atendimentos.router, prefix=router_prefix)
app.include_router(servicos.router, prefix=router_prefix)
app.include_router(estoque.router, prefix=router_prefix)
app.include_router(kits.router, prefix=router_prefix)
app.include_router(gastos.router, prefix=router_prefix)
app.include_router(alertas.router, prefix=router_prefix)


@app.get("/", include_in_schema=False)
def root():
    return {"servico": "Salon API", "docs": "/docs", "health": "/health"}
