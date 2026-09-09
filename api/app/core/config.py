from pydantic_settings import BaseSettings
from pydantic import Field
from functools import lru_cache


class Settings(BaseSettings):
    # Supabase
    supabase_url: str = Field(..., validation_alias="SUPABASE_URL")
    supabase_service_key: str = Field(..., validation_alias="SUPABASE_SERVICE_KEY")
    supabase_anon_key: str = Field(..., validation_alias="SUPABASE_ANON_KEY")
    supabase_jwt_secret: str = Field(default="", validation_alias="SUPABASE_JWT_SECRET")

    # CORS — lista separada por vírgula no .env
    cors_origins: str = Field(
        default="http://localhost:3000,http://localhost:8080",
        validation_alias="CORS_ORIGINS",
    )

    # n8n
    n8n_base_url: str = Field(default="", validation_alias="N8N_BASE_URL")
    n8n_webhook_alerta_saldo: str = Field(
        default="webhook/alerta-saldo-mensal",
        validation_alias="N8N_WEBHOOK_ALERTA_SALDO",
    )
    n8n_webhook_resumo_semanal: str = Field(
        default="webhook/resumo-semanal",
        validation_alias="N8N_WEBHOOK_RESUMO_SEMANAL",
    )
    n8n_secret: str = Field(..., validation_alias="N8N_SECRET")

    # App
    environment: str = Field(default="development", validation_alias="ENVIRONMENT")
    link_agendamento_base_url: str = Field(
        default="http://localhost:8082/agendar",
        validation_alias="LINK_AGENDAMENTO_BASE_URL",
    )

    # Web Push (VAPID). A chave pública também fica no frontend; a privada
    # nunca sai da API.
    web_push_vapid_public_key: str = Field(
        default="", validation_alias="WEB_PUSH_VAPID_PUBLIC_KEY"
    )
    web_push_vapid_private_key: str = Field(
        default="", validation_alias="WEB_PUSH_VAPID_PRIVATE_KEY"
    )
    web_push_vapid_subject: str = Field(
        default="", validation_alias="WEB_PUSH_VAPID_SUBJECT"
    )

    # Realtime dos alertas (Upstash Redis via REST). Opcional: sem essas
    # variáveis o app continua usando o polling de segurança.
    upstash_redis_rest_url: str = Field(
        default="", validation_alias="UPSTASH_REDIS_REST_URL"
    )
    upstash_redis_rest_token: str = Field(
        default="", validation_alias="UPSTASH_REDIS_REST_TOKEN"
    )

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    model_config = {"env_file": ".env", "extra": "ignore"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
