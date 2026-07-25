from pydantic import model_validator
from pydantic_settings import BaseSettings

_DEFAULT_SECRET_KEY = "change-this-in-production-min-32-chars"
_PLACEHOLDER_SECRET_KEYS = {
    _DEFAULT_SECRET_KEY,
    "replace-with-a-random-secret-at-least-32-characters",
}


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://planpilot:password@localhost:5432/planpilot"
    secret_key: str = _DEFAULT_SECRET_KEY
    access_token_expire_days: int = 7
    openai_api_key: str = ""
    openai_base_url: str = ""
    model_name: str = "deepseek-chat"
    smart_api_key: str = ""
    smart_base_url: str = ""
    smart_model_name: str = "deepseek-v4-flash"
    smart_pro_model_name: str = "deepseek-v4-pro"
    embedding_api_key: str = ""
    embedding_base_url: str = ""
    embedding_model_name: str = "qwen3-embedding-0.6b"
    embedding_dimensions: int = 1024

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

    @model_validator(mode="after")
    def enforce_secret_key(self) -> "Settings":
        if self.secret_key in _PLACEHOLDER_SECRET_KEYS:
            raise ValueError(
                "SECRET_KEY 使用了默认占位值，拒绝启动。"
                "请在 backend/.env 中设置一个随机字符串（至少 32 位）：\n"
                "  python3 -c \"import secrets; print(secrets.token_hex(32))\""
            )
        if len(self.secret_key) < 32:
            raise ValueError(
                f"SECRET_KEY 长度不足（当前 {len(self.secret_key)} 位，要求至少 32 位）"
            )
        if self.embedding_dimensions != 1024:
            raise ValueError(
                "EMBEDDING_DIMENSIONS 必须为 1024，与数据库 vector(1024) 保持一致"
            )
        return self


settings = Settings()
