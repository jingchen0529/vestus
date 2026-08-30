"""Typed configuration for the Vestus backend.

Every ``VESTUS_*`` environment variable the service understands is declared
once in :class:`Settings`.  :func:`get_settings` is deliberately **not**
cached: a handful of knobs (product name, upload directory and size limit) are
re-read per request so operators can change them without a restart, and the
test suite depends on that.  Constructing ``Settings`` only reads
``os.environ``, so there is no per-call file I/O.

Startup-time enforcement lives in :func:`validate_startup_settings`, which is
called once from ``create_app()``.  It refuses to boot when the token signing
secret is missing, a published placeholder, or too weak to be a real key --
previously a missing key silently fell back to a per-process random value,
which invalidated every token on restart and made multi-worker deployments
reject each other's sessions.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_PRODUCT_NAME = "Vestus"
MAX_PRODUCT_NAME_LENGTH = 100
DEFAULT_CORS_ORIGINS = "http://localhost:5174,http://127.0.0.1:5174"
DEFAULT_TOKEN_TTL_SECONDS = 900
DEFAULT_LOGIN_MAX_ATTEMPTS = 5
DEFAULT_LOGIN_LOCK_MINUTES = 15
DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024
DEFAULT_SQLITE_PATH = REPO_ROOT / "vestus-dev.db"
DEFAULT_UPLOAD_DIR = REPO_ROOT / "uploads"

MIN_SECRET_LENGTH = 32
MIN_SECRET_DISTINCT_CHARACTERS = 10
MIN_BOOTSTRAP_PASSWORD_LENGTH = 8
PLACEHOLDER_MARKERS = (
    "replace-with",
    "change-me",
    "changeme",
    "placeholder",
    "your-secret",
    "your-key",
)

TRUE_FLAGS = frozenset({"1", "true", "yes", "on"})


def _load_project_env() -> None:
    """Load the repository ``.env`` without overriding a real environment."""

    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - python-dotenv is a hard dependency
        return
    env_file = REPO_ROOT / ".env"
    if env_file.is_file():
        load_dotenv(env_file, override=False)


_load_project_env()


def _positive_int(value: Any, default: int) -> int:
    """Mirror the historic ``_int_env`` behaviour: fall back on junk input."""

    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


_TOLERANT_INT_DEFAULTS = {
    "access_token_ttl_seconds": DEFAULT_TOKEN_TTL_SECONDS,
    "login_max_attempts": DEFAULT_LOGIN_MAX_ATTEMPTS,
    "login_lock_minutes": DEFAULT_LOGIN_LOCK_MINUTES,
    "upload_max_bytes": DEFAULT_MAX_UPLOAD_BYTES,
}


class Settings(BaseSettings):
    """Every ``VESTUS_*`` variable the Python service reads.

    Numeric and boolean knobs stay tolerant of malformed input (falling back to
    the documented default) so a typo in ``.env`` cannot take the service down.
    Secrets are the exception: they are validated strictly, once, at startup.
    """

    model_config = SettingsConfigDict(env_prefix="VESTUS_", extra="ignore", case_sensitive=False)

    database_url: str = ""
    sqlite_fallback: bool = False
    sqlite_path: str = ""

    secret_key: str = ""
    jwt_secret: str = ""
    proxy_secret_key: str = ""

    access_token_ttl_seconds: int = DEFAULT_TOKEN_TTL_SECONDS
    login_max_attempts: int = DEFAULT_LOGIN_MAX_ATTEMPTS
    login_lock_minutes: int = DEFAULT_LOGIN_LOCK_MINUTES
    cookie_secure: bool = False
    cors_origins: str = DEFAULT_CORS_ORIGINS

    product_name: str = ""
    upload_dir: str = ""
    upload_max_bytes: int = DEFAULT_MAX_UPLOAD_BYTES

    bootstrap_admin_username: str = ""
    bootstrap_admin_password: str = ""
    bootstrap_admin_name: str = "系统管理员"
    admin_username: str = ""
    admin_password: str = ""

    @field_validator(*_TOLERANT_INT_DEFAULTS, mode="before")
    @classmethod
    def _tolerant_positive_int(cls, value: Any, info: ValidationInfo) -> int:
        assert info.field_name is not None
        return _positive_int(value, _TOLERANT_INT_DEFAULTS[info.field_name])

    @field_validator("sqlite_fallback", "cookie_secure", mode="before")
    @classmethod
    def _tolerant_flag(cls, value: Any) -> bool:
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in TRUE_FLAGS

    @property
    def cors_origin_list(self) -> list[str]:
        raw = self.cors_origins or DEFAULT_CORS_ORIGINS
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    @property
    def resolved_product_name(self) -> str:
        """Reject blank, oversized or non-printable names, exactly as before."""

        name = (self.product_name or "").strip()
        if not name or len(name) > MAX_PRODUCT_NAME_LENGTH or not name.isprintable():
            return DEFAULT_PRODUCT_NAME
        return name

    @property
    def upload_root(self) -> Path:
        configured = (self.upload_dir or "").strip()
        base = Path(configured).expanduser() if configured else DEFAULT_UPLOAD_DIR
        return base.resolve()

    @property
    def resolved_sqlite_path(self) -> str:
        return (self.sqlite_path or "").strip() or str(DEFAULT_SQLITE_PATH)

    @property
    def token_signing_secret(self) -> str:
        return self.secret_key or self.jwt_secret

    @property
    def proxy_encryption_secret(self) -> str:
        return self.proxy_secret_key or self.secret_key or self.jwt_secret

    @property
    def bootstrap_username(self) -> str:
        return (self.bootstrap_admin_username or self.admin_username or "admin").strip()

    @property
    def bootstrap_password(self) -> str:
        return self.bootstrap_admin_password or self.admin_password


def get_settings() -> Settings:
    """Build a :class:`Settings` from the current process environment.

    Intentionally uncached -- see the module docstring.
    """

    return Settings()


class ConfigurationError(RuntimeError):
    """Raised at startup when the environment cannot support a safe boot."""


def _looks_like_placeholder(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in PLACEHOLDER_MARKERS)


def _secret_problem(value: str) -> str | None:
    if _looks_like_placeholder(value):
        return "仍是文档里的示例占位值"
    if len(value) < MIN_SECRET_LENGTH:
        return f"长度不足 {MIN_SECRET_LENGTH} 个字符"
    if len(set(value)) < MIN_SECRET_DISTINCT_CHARACTERS:
        return f"只有 {len(set(value))} 种字符，熵太低（至少 {MIN_SECRET_DISTINCT_CHARACTERS} 种）"
    return None


def validate_startup_settings(settings: Settings | None = None) -> Settings:
    """Refuse to boot on a configuration that silently degrades security.

    Collect every problem before raising so a fresh deployment sees the whole
    list in one go instead of fixing them one restart at a time.
    """

    settings = settings or get_settings()
    problems: list[str] = []

    if not settings.database_url.strip():
        problems.append("VESTUS_DATABASE_URL 未设置：请在项目根目录 .env 中配置数据库连接")

    token_secret = settings.token_signing_secret
    if not token_secret:
        problems.append(
            "VESTUS_SECRET_KEY 未设置：没有稳定密钥时，重启会使所有登录失效，"
            "多 worker 部署还会互相拒绝会话。请用 `openssl rand -hex 32` 生成后写入 .env"
        )
    else:
        problem = _secret_problem(token_secret)
        if problem is not None:
            problems.append(f"VESTUS_SECRET_KEY {problem}")

    if settings.proxy_secret_key:
        problem = _secret_problem(settings.proxy_secret_key)
        if problem is not None:
            problems.append(f"VESTUS_PROXY_SECRET_KEY {problem}")

    password = settings.bootstrap_password
    if password:
        if _looks_like_placeholder(password):
            problems.append("VESTUS_BOOTSTRAP_ADMIN_PASSWORD 仍是文档里的示例占位值")
        elif len(password) < MIN_BOOTSTRAP_PASSWORD_LENGTH:
            problems.append(
                f"VESTUS_BOOTSTRAP_ADMIN_PASSWORD 长度不足 {MIN_BOOTSTRAP_PASSWORD_LENGTH} 个字符"
            )

    if problems:
        raise ConfigurationError("Vestus 配置校验失败：\n  - " + "\n  - ".join(problems))
    return settings


__all__ = [
    "ConfigurationError",
    "DEFAULT_CORS_ORIGINS",
    "DEFAULT_MAX_UPLOAD_BYTES",
    "DEFAULT_PRODUCT_NAME",
    "DEFAULT_SQLITE_PATH",
    "DEFAULT_TOKEN_TTL_SECONDS",
    "REPO_ROOT",
    "Settings",
    "get_settings",
    "validate_startup_settings",
]
