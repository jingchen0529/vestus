"""Alembic environment.

The connection URL is resolved here rather than in ``alembic.ini`` so that the
application, the test-suite and the migrations always agree on the target
database.  Precedence, highest first:

1. ``config.attributes["connection"]`` -- an already-open connection, which is
   how ``scripts/init_db.py`` reuses the engine it just built;
2. ``alembic -x url=...`` -- a one-off override;
3. ``VESTUS_DATABASE_URL`` via :func:`app.core.config.get_settings`.
"""

from __future__ import annotations

from logging.config import fileConfig
from typing import Any

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import get_settings
from app.db import models  # noqa: F401  -- imported for its side effect: registers every table
from app.db.base import Base

config = context.config

if config.config_file_name is not None:
    # Keep the caller's logging intact: init_db.py drives Alembic in-process.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def database_url() -> str:
    override = context.get_x_argument(as_dictionary=True).get("url")
    if override:
        return override
    configured = get_settings().database_url
    if not configured or not configured.strip():
        raise RuntimeError("未配置 VESTUS_DATABASE_URL，请在项目根目录 .env 中设置数据库连接")
    return configured.strip()


def run_migrations(connection: Any) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    existing = config.attributes.get("connection")
    if existing is not None:
        run_migrations(existing)
        return
    connectable = engine_from_config(
        {"sqlalchemy.url": database_url()}, prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    try:
        with connectable.connect() as connection:
            run_migrations(connection)
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
