from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://planpilot:password@localhost:5432/planpilot"
    secret_key: str = "change-this-in-production-min-32-chars"
    access_token_expire_days: int = 7
    openai_api_key: str = ""
    openai_base_url: str = ""
    model_name: str = "deepseek-chat"
    smart_api_key: str = ""
    smart_base_url: str = ""
    smart_model_name: str = "deepseek-chat"

    redis_url: str = "redis://localhost:6379/0"
    tavily_api_key: str = ""

    # SMTP (QQ邮箱)
    smtp_host: str = "smtp.qq.com"
    smtp_port: int = 587
    smtp_user: str = ""       # QQ邮箱地址
    smtp_password: str = ""   # QQ邮箱授权码
    smtp_from_name: str = "PlanPilot"

    sentry_dsn: str = ""

    model_config = {"env_file": ".env"}


settings = Settings()
