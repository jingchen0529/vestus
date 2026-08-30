"""Engine/session lifecycle plus first-boot database preparation.

The class is intentionally thin: it owns the engine, the session factory and
the once-per-process bootstrap.  Every query lives in :mod:`app.repositories`
and every transaction boundary in :mod:`app.services`.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, Optional, cast

from sqlalchemy import CursorResult, create_engine, desc, insert, select, text, update
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import DEFAULT_SQLITE_PATH, get_settings
from app.core.security import hash_password
from app.db.base import Base, utc_now
from app.db.models import Admin, Proxy, SystemSetting

GLOBAL_PROXY_LOCK_KEY = "__global_proxy_activation_lock__"


def lock_global_proxy_activation(session: Session) -> None:
    """Take a real write lock that works even when no proxy is active.

    A direct UPDATE is deliberately the first proxy-state statement. MySQL
    locks this stable row, while SQLite acquires its database write lock;
    ``SELECT ... FOR UPDATE`` alone is ineffective on SQLite and cannot lock
    an empty active-proxy result set reliably on every isolation level.
    """
    # ``Session.execute`` is typed as returning ``Result``, but a DML statement
    # always yields a ``CursorResult`` -- the object that carries ``rowcount``.
    result = cast(
        "CursorResult[Any]",
        session.execute(
            update(SystemSetting)
            .where(SystemSetting.key == GLOBAL_PROXY_LOCK_KEY)
            .values(updated_at=utc_now())
        ),
    )
    if result.rowcount != 1:
        raise RuntimeError("global proxy activation lock is missing")


class Database:
    """Engine + session factory for the sync SQLAlchemy stack."""

    def __init__(self, url: Optional[str] = None, *, initialize: bool = True) -> None:
        configured_url = url or get_settings().database_url
        if not configured_url or not configured_url.strip():
            raise RuntimeError(
                "未配置 VESTUS_DATABASE_URL，请在项目根目录 .env 中设置数据库连接"
            )
        self.url = configured_url.strip()
        # SQLite needs this flag for FastAPI's worker threads.  MySQL pooling
        # defaults are suitable for a small admin service.
        kwargs: Dict[str, Any] = {"future": True, "pool_pre_ping": True}
        if self.url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        self.engine: Engine = create_engine(self.url, **kwargs)
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False, future=True)
        self.available = True
        self.initialization_error: Optional[str] = None
        if initialize:
            self.initialize()

    @contextmanager
    def session(self) -> Iterator[Session]:
        db = self.SessionLocal()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    # ``connection`` is retained as a convenient health-check compatibility
    # alias; callers should use ``session`` for ORM operations.
    @contextmanager
    def connection(self) -> Iterator[Session]:
        with self.session() as db:
            yield db

    def dispose(self) -> None:
        self.engine.dispose()

    def initialize(self) -> None:
        """Create missing tables and prepare singleton rows.

        Alembic owns schema changes in production (``scripts/init_db.py``);
        ``create_all`` stays here as the test/dev bootstrap and as the
        documented fallback for a brand-new empty database.
        """
        settings = get_settings()
        try:
            Base.metadata.create_all(self.engine)
            self.available = True
            self.initialization_error = None
            self._ensure_global_proxy_lock()
            self._normalize_active_proxies()
            self._bootstrap_admin()
        except SQLAlchemyError as exc:
            self.available = False
            self.initialization_error = str(exc)
            if settings.sqlite_fallback and not self.url.startswith("sqlite"):
                fallback = settings.resolved_sqlite_path or str(DEFAULT_SQLITE_PATH)
                self.url = f"sqlite:///{Path(fallback).expanduser()}"
                self.engine = create_engine(self.url, connect_args={"check_same_thread": False}, future=True)
                self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False, future=True)
                Base.metadata.create_all(self.engine)
                self.available = True
                self.initialization_error = None
                self._ensure_global_proxy_lock()
                self._normalize_active_proxies()
                self._bootstrap_admin()

    def ping(self) -> bool:
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            self.available = True
            return True
        except SQLAlchemyError:
            self.available = False
            return False

    def _ensure_global_proxy_lock(self) -> None:
        """Create the stable row used to serialize global proxy activation."""
        values = {
            "key": GLOBAL_PROXY_LOCK_KEY,
            "value": "",
            "updated_at": utc_now(),
        }
        dialect = self.engine.dialect.name
        with self.engine.begin() as connection:
            if dialect == "sqlite":
                statement = (
                    sqlite_insert(SystemSetting)
                    .values(**values)
                    .on_conflict_do_nothing(index_elements=[SystemSetting.key])
                )
                connection.execute(statement)
            elif dialect == "mysql":
                connection.execute(
                    mysql_insert(SystemSetting).values(**values).prefix_with("IGNORE")
                )
            else:
                existing = connection.scalar(
                    select(SystemSetting.id).where(
                        SystemSetting.key == GLOBAL_PROXY_LOCK_KEY
                    )
                )
                if existing is None:
                    connection.execute(insert(SystemSetting).values(**values))

    def _normalize_active_proxies(self) -> None:
        """Keep only the most recently updated legacy active proxy."""
        with self.session() as db:
            lock_global_proxy_activation(db)
            active_proxies = db.scalars(
                select(Proxy)
                .where(Proxy.status == "active")
                .order_by(desc(Proxy.updated_at), desc(Proxy.id))
                .with_for_update()
            ).all()
            if len(active_proxies) <= 1:
                return
            replaced_at = utc_now()
            for proxy in active_proxies[1:]:
                proxy.status = "disabled"
                proxy.updated_at = replaced_at

    def _bootstrap_admin(self) -> None:
        # Deliberately no weak built-in password.  Set both variables in a
        # deployment/bootstrap environment to create the first administrator.
        settings = get_settings()
        password = settings.bootstrap_password
        if not password:
            return
        username = settings.bootstrap_username or "admin"
        with self.session() as db:
            existing = db.scalar(select(Admin).where(Admin.username == username, Admin.deleted_at.is_(None)))
            if existing is None:
                db.add(
                    Admin(
                        username=username,
                        password_hash=hash_password(password),
                        name=settings.bootstrap_admin_name or "系统管理员",
                        role="super_admin",
                        status="active",
                        password_changed_at=utc_now(),
                    )
                )


__all__ = ["Database", "GLOBAL_PROXY_LOCK_KEY", "lock_global_proxy_activation"]
