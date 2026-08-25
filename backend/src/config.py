from urllib.parse import urlsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEFAULT_SECRET_KEY = "change-this-in-production-min-32-chars"
_PLACEHOLDER_SECRET_KEYS = {
    _DEFAULT_SECRET_KEY,
    "replace-with-a-random-secret-at-least-32-characters",
}


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://planpilot:password@localhost:5432/planpilot"
    secret_key: str = _DEFAULT_SECRET_KEY
    # Browser sessions use a short-lived access JWT plus a rotating opaque
    # refresh token.  The access lifetime must stay short even when the user
    # selects "remember me"; that choice only changes refresh persistence.
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 30
    session_refresh_token_expire_hours: int = 24
    refresh_token_reuse_grace_seconds: int = 5
    auth_redis_failure_policy: str = "session_authoritative"
    # Deprecated environment keys are accepted during rolling deployment but
    # intentionally never used to lengthen the short-lived access token.
    access_token_expire_days: int | None = None
    session_token_expire_hours: int | None = None
    auth_access_cookie_name: str = "pp_access"
    auth_refresh_cookie_name: str = "pp_refresh"
    auth_csrf_cookie_name: str = "pp_csrf"
    auth_cookie_samesite: str = "lax"
    auth_cookie_secure: bool | None = None
    openai_api_key: str = ""
    openai_base_url: str = ""
    model_name: str = ""
    local_model_enabled: bool = True
    local_model_timeout_seconds: float = 30.0
    local_model_failure_threshold: int = 2
    local_model_circuit_cooldown_seconds: float = 60.0
    local_model_max_concurrency: int = 1
    local_model_queue_timeout_seconds: float = 2.0
    smart_api_key: str = ""
    smart_base_url: str = ""
    smart_model_name: str = "deepseek-v4-flash"
    smart_pro_model_name: str = "deepseek-v4-pro"
    cloud_routine_timeout_seconds: float = 60.0
    cloud_pro_timeout_seconds: float = 300.0
    cloud_model_max_retries: int = 0
    cloud_routine_max_concurrency: int = 4
    cloud_pro_max_concurrency: int = 1
    cloud_model_queue_timeout_seconds: float = 5.0
    model_gateway_max_retries: int = 1
    model_gateway_failure_threshold: int = 3
    model_gateway_circuit_cooldown_seconds: float = 60.0
    model_gateway_half_open_probe_seconds: float = 15.0
    model_gateway_redis_prefix: str = "model_gateway"
    coach_agent_enabled: bool = True
    embedding_api_key: str = ""
    embedding_base_url: str = ""
    embedding_model_name: str = "qwen3-embedding-0.6b"
    embedding_dimensions: int = 1024
    embedding_timeout_seconds: float = 30.0
    embedding_max_retries: int = 1
    embedding_max_concurrency: int = 1
    runtime_model_config_path: str = "uploads/system/model-runtime.json"

    redis_url: str = "redis://localhost:6379/0"
    tavily_api_key: str = ""

    # SMTP (QQ邮箱)
    smtp_host: str = "smtp.qq.com"
    smtp_port: int = 587
    smtp_user: str = ""  # QQ邮箱地址
    smtp_password: str = ""  # QQ邮箱授权码
    smtp_from_name: str = "PlanPilot"
    frontend_url: str = "http://localhost:3000"

    sentry_dsn: str = ""
    sentry_traces_sample_rate: float = 0.1
    environment: str = "development"
    log_level: str = "INFO"
    cors_origins: str = (
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001"
    )
    avatar_upload_dir: str = "uploads/avatars"
    storage_backend: str = "local"
    storage_local_root: str = "uploads"
    storage_s3_bucket: str = "planpilot"
    storage_s3_endpoint_url: str = ""
    storage_s3_region: str = "us-east-1"
    storage_s3_access_key: str = ""
    storage_s3_secret_key: str = ""
    storage_s3_secure: bool = True
    storage_s3_server_side_encryption: str = ""
    otel_service_name: str = "planpilot-api"
    otel_exporter_otlp_endpoint: str = ""
    otel_traces_sample_ratio: float = 0.1
    learning_event_retention_days: int = 730
    prediction_retention_days: int = 730
    agent_observability_retention_days: int = 365
    data_quality_retention_days: int = 730
    export_audit_retention_days: int = 1095
    expired_session_retention_days: int = 30
    beta_runtime_gate_ttl_hours: int = 24
    beta_safety_observation_ttl_hours: int = 6
    beta_safety_scan_lookback_hours: int = 24
    beta_review_sample_retention_days: int = 90

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def secure_auth_cookies(self) -> bool:
        if self.auth_cookie_secure is not None:
            return self.auth_cookie_secure
        return self.environment.lower() not in {"development", "test"}

    # Ignore deprecated rolling-deployment aliases (for example
    # PLANPILOT_LOCAL_LLM_URL) so host-side evaluation/re-scoring can import
    # the same settings module as the containers without extra-field failure.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @model_validator(mode="after")
    def enforce_secret_key(self) -> "Settings":
        if self.secret_key in _PLACEHOLDER_SECRET_KEYS:
            raise ValueError(
                "SECRET_KEY 使用了默认占位值，拒绝启动。"
                "请在 backend/.env 中设置一个随机字符串（至少 32 位）：\n"
                '  python3 -c "import secrets; print(secrets.token_hex(32))"'
            )
        if len(self.secret_key) < 32:
            raise ValueError(
                f"SECRET_KEY 长度不足（当前 {len(self.secret_key)} 位，要求至少 32 位）"
            )
        if self.embedding_dimensions != 1024:
            raise ValueError("EMBEDDING_DIMENSIONS 必须为 1024，与数据库 vector(1024) 保持一致")
        if self.local_model_max_concurrency < 1:
            raise ValueError("LOCAL_MODEL_MAX_CONCURRENCY 必须至少为 1")
        if self.cloud_routine_max_concurrency < 1:
            raise ValueError("CLOUD_ROUTINE_MAX_CONCURRENCY 必须至少为 1")
        if self.cloud_pro_max_concurrency < 1:
            raise ValueError("CLOUD_PRO_MAX_CONCURRENCY 必须至少为 1")
        if self.embedding_max_concurrency < 1:
            raise ValueError("EMBEDDING_MAX_CONCURRENCY 必须至少为 1")
        if self.model_gateway_max_retries < 0:
            raise ValueError("MODEL_GATEWAY_MAX_RETRIES 不能为负数")
        if self.model_gateway_failure_threshold < 1:
            raise ValueError("MODEL_GATEWAY_FAILURE_THRESHOLD 必须至少为 1")
        if not 0.0 <= self.sentry_traces_sample_rate <= 1.0:
            raise ValueError("SENTRY_TRACES_SAMPLE_RATE 必须在 0 到 1 之间")
        if self.storage_backend not in {"local", "s3"}:
            raise ValueError("STORAGE_BACKEND 必须是 local 或 s3")
        if self.storage_backend == "s3" and not (
            self.storage_s3_bucket and self.storage_s3_access_key and self.storage_s3_secret_key
        ):
            raise ValueError("S3 存储必须配置 bucket、access key 和 secret key")
        if self.storage_s3_server_side_encryption not in {"", "AES256", "aws:kms"}:
            raise ValueError("S3 服务端加密只能为空、AES256 或 aws:kms")
        if not 0.0 <= self.otel_traces_sample_ratio <= 1.0:
            raise ValueError("OTEL_TRACES_SAMPLE_RATIO 必须在 0 到 1 之间")
        if self.access_token_expire_minutes < 5 or self.access_token_expire_minutes > 30:
            raise ValueError("ACCESS_TOKEN_EXPIRE_MINUTES 必须在 5 到 30 分钟之间")
        if self.refresh_token_expire_days < 1:
            raise ValueError("REFRESH_TOKEN_EXPIRE_DAYS 必须至少为 1 天")
        if self.session_refresh_token_expire_hours < 1:
            raise ValueError("SESSION_REFRESH_TOKEN_EXPIRE_HOURS 必须至少为 1 小时")
        if not 0 <= self.refresh_token_reuse_grace_seconds <= 10:
            raise ValueError("REFRESH_TOKEN_REUSE_GRACE_SECONDS 必须在 0 到 10 秒之间")
        if self.auth_redis_failure_policy not in {"session_authoritative", "fail_closed"}:
            raise ValueError(
                "AUTH_REDIS_FAILURE_POLICY 必须是 session_authoritative 或 fail_closed"
            )
        retention_values = (
            self.learning_event_retention_days,
            self.prediction_retention_days,
            self.agent_observability_retention_days,
            self.data_quality_retention_days,
            self.export_audit_retention_days,
            self.expired_session_retention_days,
            self.beta_runtime_gate_ttl_hours,
            self.beta_safety_observation_ttl_hours,
            self.beta_safety_scan_lookback_hours,
            self.beta_review_sample_retention_days,
        )
        if any(value < 1 for value in retention_values):
            raise ValueError("数据留存天数必须至少为 1")
        if self.auth_cookie_samesite.lower() not in {"lax", "strict", "none"}:
            raise ValueError("AUTH_COOKIE_SAMESITE 必须是 lax、strict 或 none")
        if self.auth_cookie_samesite.lower() == "none" and not self.secure_auth_cookies:
            raise ValueError("SameSite=None 的认证 Cookie 必须启用 Secure")
        if self.environment.lower() == "production" and not self.secure_auth_cookies:
            raise ValueError("生产环境认证 Cookie 必须启用 Secure")
        if self.environment.lower() == "production":
            if self.storage_backend != "s3":
                raise ValueError("生产环境必须使用 S3 兼容对象存储")
            frontend = urlsplit(self.frontend_url)
            if frontend.scheme != "https" or not frontend.hostname or frontend.username:
                raise ValueError("生产环境 FRONTEND_URL 必须是无用户信息的 HTTPS 地址")
            for origin in self.cors_origin_list:
                parsed = urlsplit(origin)
                if (
                    origin == "*"
                    or parsed.scheme != "https"
                    or not parsed.hostname
                    or parsed.username
                    or parsed.path not in {"", "/"}
                    or parsed.query
                    or parsed.fragment
                ):
                    raise ValueError(
                        "生产环境 CORS_ORIGINS 只能包含无路径、无用户信息的 HTTPS Origin"
                    )
        return self


settings = Settings()
