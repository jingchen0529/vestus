"""SQLAlchemy persistence for the Vestus backend.

Account/audit tables plus the proxy, platform and assignment tables are
created. The connection URL must be supplied through ``VESTUS_DATABASE_URL``;
tests and local development can explicitly select SQLite with
``VESTUS_DATABASE_URL=sqlite:///...``.
No session table is used: signed access tokens carry a token version which is
checked against the account row on every request.
"""

from __future__ import annotations

import os
import hashlib
import json
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from ipaddress import ip_address
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    and_,
    create_engine,
    delete,
    desc,
    func,
    or_,
    select,
    text,
)
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from file_storage import is_inline_safe, normalize_upload_reference
from security import decrypt_proxy_password, encrypt_proxy_password, hash_password


DEFAULT_SQLITE_PATH = Path(__file__).resolve().with_name("vestus-dev.db")


class LastSuperAdminError(ValueError):
    """Raised when a mutation would remove the last active super administrator."""


def utc_now() -> datetime:
    """Return a naive UTC datetime suitable for MySQL DATETIME(6)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_datetime(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="seconds") + "Z"


def parse_datetime(value: Any, *, end_of_day: bool = False) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, date):
        result = datetime.combine(value, datetime.min.time())
    else:
        raw = str(value).strip()
        if len(raw) == 10:
            result = datetime.combine(date.fromisoformat(raw), datetime.min.time())
        else:
            result = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if result.tzinfo is not None:
        result = result.astimezone(timezone.utc).replace(tzinfo=None)
    if end_of_day and len(str(value)) == 10:
        result = result.replace(hour=23, minute=59, second=59, microsecond=999999)
    return result


def ip_bytes(value: Optional[str]) -> Optional[bytes]:
    if not value:
        return None
    try:
        return ip_address(value).packed
    except ValueError:
        return None


def ip_text(value: Optional[bytes]) -> Optional[str]:
    if not value:
        return None
    try:
        return str(ip_address(value))
    except ValueError:
        return None


class Base(DeclarativeBase):
    pass


IdType = BigInteger().with_variant(Integer, "sqlite")
DateTime6 = MySQLDateTime(fsp=6).with_variant(DateTime(), "sqlite")


class Admin(Base):
    __tablename__ = "admin"
    __table_args__ = (
        UniqueConstraint("username", name="uq_admin_username"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="admin")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)
    last_login_ip: Mapped[Optional[bytes]] = mapped_column(LargeBinary(16), nullable=True)
    password_changed_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)


class User(Base):
    __tablename__ = "user"
    __table_args__ = (
        UniqueConstraint("username", name="uq_user_username"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    company: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True, index=True)
    max_sessions: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    failed_login_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    locked_until: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)
    last_login_ip: Mapped[Optional[bytes]] = mapped_column(LargeBinary(16), nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(IdType, nullable=True)
    remark: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)


class Proxy(Base):
    """An administrator-managed upstream proxy.

    The credential is never serialized directly.  ``encrypted_password`` is
    a Fernet token, not a password hash, because the desktop client must be
    able to receive the original credential after authenticating.
    """

    __tablename__ = "proxy"
    __table_args__ = (
        UniqueConstraint("name", name="uq_proxy_name"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    encrypted_password: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    #: Hostnames the desktop client must reach directly instead of through this
    #: proxy.  ``NULL``/empty means every request is proxied.
    bypass_hosts: Mapped[Optional[List[str]]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)


class Platform(Base):
    """A centrally-managed browser shortcut available to desktop users."""

    __tablename__ = "platform"
    __table_args__ = (
        UniqueConstraint("name", name="uq_platform_name"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    icon_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)


class UserProxyAssignment(Base):
    __tablename__ = "user_proxy_assignment"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_user_proxy_assignment_user"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    proxy_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)


class UserPlatformAssignment(Base):
    __tablename__ = "user_platform_assignment"
    __table_args__ = (
        UniqueConstraint("user_id", "platform_id", name="uq_user_platform_assignment"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    platform_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)


class UserLog(Base):
    __tablename__ = "user_log"
    __table_args__ = (
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    request_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    actor_type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    actor_id: Mapped[Optional[int]] = mapped_column(IdType, nullable=True)
    actor_username: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    actor_role: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    target_id: Mapped[Optional[int]] = mapped_column(IdType, nullable=True)
    target_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    ip_address: Mapped[Optional[bytes]] = mapped_column(LargeBinary(16), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    details: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, index=True)


class SystemSetting(Base):
    __tablename__ = "system_setting"
    __table_args__ = (
        UniqueConstraint("key", name="uq_system_setting_key"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)


class UploadedFile(Base):
    __tablename__ = "uploaded_file"
    __table_args__ = (
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    path: Mapped[str] = mapped_column(String(512), nullable=False, unique=True, index=True)
    content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploaded_by: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, index=True)


def _admin_dict(item: Admin) -> Dict[str, Any]:
    return {
        "id": item.id,
        "username": item.username,
        "name": item.name,
        "role": item.role,
        "status": item.status,
        "lastLoginAt": iso_datetime(item.last_login_at),
        "createdAt": iso_datetime(item.created_at),
        "updatedAt": iso_datetime(item.updated_at),
    }


def _user_dict(item: User) -> Dict[str, Any]:
    # The first desktop client accepts a calendar date. Keep the storage
    # precision in MySQL while exposing the stable date-shaped contract.
    expires_value = item.expires_at.date().isoformat() if item.expires_at is not None else None
    return {
        "id": item.id,
        "username": item.username,
        "name": item.name,
        "role": "client",
        "company": item.company,
        "phone": item.phone,
        "status": item.status,
        "expiresAt": expires_value,
        "maxSessions": item.max_sessions,
        "failedLoginCount": item.failed_login_count,
        "lockedUntil": iso_datetime(item.locked_until),
        "mustChangePassword": bool(item.must_change_password),
        "createdBy": item.created_by,
        "remark": item.remark,
        "createdAt": iso_datetime(item.created_at),
        "updatedAt": iso_datetime(item.updated_at),
        "lastLoginAt": iso_datetime(item.last_login_at),
    }


def _proxy_bypass_hosts(item: Proxy) -> List[str]:
    """Normalize the stored direct-connect list into a plain list of strings.

    Rows written before the column existed hold ``NULL``; legacy rows may also
    hold a non-list value, which is treated as "no exceptions" rather than
    propagated to the desktop client.
    """
    raw = item.bypass_hosts
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, str) and entry]


def _proxy_dict(item: Proxy) -> Dict[str, Any]:
    """Serialize proxy metadata without exposing either credential form."""
    return {
        "id": item.id,
        "name": item.name,
        "host": item.host,
        "port": item.port,
        "username": item.username,
        "bypassHosts": _proxy_bypass_hosts(item),
        "status": item.status,
        "createdAt": iso_datetime(item.created_at),
        "updatedAt": iso_datetime(item.updated_at),
    }


def _desktop_proxy_dict(item: Proxy) -> Dict[str, Any]:
    """Serialize a proxy credential only for the authenticated desktop API."""
    return {
        "id": item.id,
        "name": item.name,
        "host": item.host,
        "port": item.port,
        "username": item.username,
        "password": decrypt_proxy_password(item.encrypted_password),
        "bypassHosts": _proxy_bypass_hosts(item),
    }


def _safe_image_reference(
    value: Optional[str], uploaded_file: Optional[UploadedFile]
) -> str:
    try:
        normalized = normalize_upload_reference(value or "")
    except ValueError:
        return ""
    if (
        not normalized
        or uploaded_file is None
        or uploaded_file.path != normalized
        or not is_inline_safe(uploaded_file.path, uploaded_file.content_type)
    ):
        return ""
    return normalized


def _validated_image_reference(
    session: Session, value: Optional[str]
) -> Tuple[str, Optional[UploadedFile]]:
    normalized = normalize_upload_reference(value or "")
    if not normalized:
        return "", None
    uploaded_file = session.scalar(
        select(UploadedFile).where(UploadedFile.path == normalized)
    )
    if uploaded_file is None or not is_inline_safe(
        uploaded_file.path, uploaded_file.content_type
    ):
        raise ValueError("图片必须引用已上传的安全图片文件")
    return normalized, uploaded_file


def _platform_dict(
    item: Platform,
    *,
    desktop: bool = False,
    uploaded_file: Optional[UploadedFile] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "id": item.id,
        "name": item.name,
        "url": item.url,
        "iconUrl": _safe_image_reference(item.icon_url, uploaded_file),
        "sortOrder": item.sort_order,
    }
    if not desktop:
        result.update({
            "status": item.status,
            "createdAt": iso_datetime(item.created_at),
            "updatedAt": iso_datetime(item.updated_at),
        })
    return result


def _desktop_lease_from_snapshot(
    user_id: int,
    proxy: Optional[Proxy],
    platforms: List[Platform],
) -> str:
    """Hash the exact ORM snapshot used to serialize a desktop response.

    Password changes are represented by a digest of the Fernet ciphertext;
    plaintext proxy credentials are never decrypted or hashed here.
    """
    payload = {
        "profileKey": f"user-{user_id}",
        "proxy": None
        if proxy is None
        else {
            "id": proxy.id,
            "name": proxy.name,
            "host": proxy.host,
            "port": proxy.port,
            "username": proxy.username,
            "credentialDigest": hashlib.sha256(proxy.encrypted_password).hexdigest(),
            "bypassHosts": _proxy_bypass_hosts(proxy),
            "status": proxy.status,
            "updatedAt": proxy.updated_at.isoformat(timespec="microseconds"),
        },
        "platforms": [
            {
                "id": platform.id,
                "name": platform.name,
                "url": platform.url,
                "sortOrder": platform.sort_order,
                "status": platform.status,
                "updatedAt": platform.updated_at.isoformat(timespec="microseconds"),
            }
            for platform in platforms
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _log_dict(item: UserLog) -> Dict[str, Any]:
    return {
        "id": item.id,
        "requestId": item.request_id,
        "actorType": item.actor_type,
        "actorId": item.actor_id,
        "actorUsername": item.actor_username,
        "actorRole": item.actor_role,
        "action": item.action,
        "targetType": item.target_type,
        "targetId": item.target_id,
        "targetName": item.target_name,
        "summary": item.summary,
        "ipAddress": ip_text(item.ip_address),
        "userAgent": item.user_agent,
        "status": item.status,
        "details": item.details,
        "createdAt": iso_datetime(item.created_at),
    }


def _uploaded_file_dict(item: UploadedFile) -> Dict[str, Any]:
    return {
        "id": item.id,
        "name": item.original_name,
        "path": item.path,
        "contentType": item.content_type,
        "size": item.size,
        "uploadedBy": item.uploaded_by,
        "createdAt": iso_datetime(item.created_at),
    }


class Database:
    """Small sync SQLAlchemy repository used by FastAPI dependencies."""

    def __init__(self, url: Optional[str] = None, *, initialize: bool = True) -> None:
        configured_url = url or os.getenv("VESTUS_DATABASE_URL")
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

    def initialize(self) -> None:
        try:
            Base.metadata.create_all(self.engine)
            self.available = True
            self.initialization_error = None
            self._bootstrap_admin()
        except SQLAlchemyError as exc:
            self.available = False
            self.initialization_error = str(exc)
            if os.getenv("VESTUS_SQLITE_FALLBACK", "0") == "1" and not self.url.startswith("sqlite"):
                fallback = os.getenv("VESTUS_SQLITE_PATH", str(DEFAULT_SQLITE_PATH))
                self.url = f"sqlite:///{Path(fallback).expanduser()}"
                self.engine = create_engine(self.url, connect_args={"check_same_thread": False}, future=True)
                self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False, future=True)
                Base.metadata.create_all(self.engine)
                self.available = True
                self.initialization_error = None
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

    def _bootstrap_admin(self) -> None:
        # Deliberately no weak built-in password.  Set both variables in a
        # deployment/bootstrap environment to create the first administrator.
        password = os.getenv("VESTUS_BOOTSTRAP_ADMIN_PASSWORD") or os.getenv("VESTUS_ADMIN_PASSWORD")
        if not password:
            return
        username = (os.getenv("VESTUS_BOOTSTRAP_ADMIN_USERNAME") or os.getenv("VESTUS_ADMIN_USERNAME") or "admin").strip()
        if not username:
            username = "admin"
        with self.session() as db:
            existing = db.scalar(select(Admin).where(Admin.username == username, Admin.deleted_at.is_(None)))
            if existing is None:
                db.add(Admin(username=username, password_hash=hash_password(password), name=os.getenv("VESTUS_BOOTSTRAP_ADMIN_NAME", "系统管理员"), role="super_admin", status="active", password_changed_at=utc_now()))

    def create_uploaded_file(
        self,
        original_name: str,
        path: str,
        content_type: str,
        size: int,
        uploaded_by: int,
    ) -> Dict[str, Any]:
        if not path.startswith("/uploads/") or "://" in path:
            raise ValueError("invalid upload path")
        with self.session() as db:
            item = UploadedFile(
                original_name=original_name,
                path=path,
                content_type=content_type,
                size=size,
                uploaded_by=uploaded_by,
            )
            db.add(item)
            db.flush()
            return _uploaded_file_dict(item)

    def get_uploaded_file_by_path(self, path: str) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = db.scalar(select(UploadedFile).where(UploadedFile.path == path))
            return _uploaded_file_dict(item) if item else None

    # ---- account lookup and serialization -------------------------------------------------
    def get_admin(self, admin_id: int | str) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = db.scalar(select(Admin).where(Admin.id == int(admin_id), Admin.deleted_at.is_(None)))
            return _admin_dict(item) if item else None

    def get_admin_model(self, admin_id: int | str, db: Optional[Session] = None) -> Optional[Admin]:
        if db is not None:
            return db.scalar(select(Admin).where(Admin.id == int(admin_id), Admin.deleted_at.is_(None)))
        with self.session() as local:
            return local.scalar(select(Admin).where(Admin.id == int(admin_id), Admin.deleted_at.is_(None)))

    def find_admin_by_username(self, username: str) -> Optional[Admin]:
        with self.session() as db:
            return db.scalar(select(Admin).where(func.lower(Admin.username) == username.strip().lower(), Admin.deleted_at.is_(None)))

    def list_admins(self, search: Optional[str] = None, status: Optional[str] = None) -> List[Dict[str, Any]]:
        with self.session() as db:
            stmt = select(Admin).where(Admin.deleted_at.is_(None))
            if search:
                pattern = f"%{search.strip()}%"
                stmt = stmt.where(or_(Admin.username.like(pattern), Admin.name.like(pattern)))
            if status:
                stmt = stmt.where(Admin.status == status)
            return [_admin_dict(x) for x in db.scalars(stmt.order_by(desc(Admin.created_at), desc(Admin.id))).all()]

    def get_user(self, user_id: int | str) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = db.scalar(select(User).where(User.id == int(user_id), User.deleted_at.is_(None)))
            return _user_dict(item) if item else None

    def get_user_model(self, user_id: int | str, db: Optional[Session] = None) -> Optional[User]:
        if db is not None:
            return db.scalar(select(User).where(User.id == int(user_id), User.deleted_at.is_(None)))
        with self.session() as local:
            return local.scalar(select(User).where(User.id == int(user_id), User.deleted_at.is_(None)))

    def find_user_by_username(self, username: str) -> Optional[User]:
        with self.session() as db:
            return db.scalar(select(User).where(func.lower(User.username) == username.strip().lower(), User.deleted_at.is_(None)))

    def list_users(self, search: Optional[str] = None, status: Optional[str] = None) -> List[Dict[str, Any]]:
        with self.session() as db:
            stmt = select(User).where(User.deleted_at.is_(None))
            if search:
                pattern = f"%{search.strip()}%"
                stmt = stmt.where(or_(User.username.like(pattern), User.name.like(pattern), User.company.like(pattern)))
            if status:
                stmt = stmt.where(User.status == status)
            return [_user_dict(x) for x in db.scalars(stmt.order_by(desc(User.created_at), desc(User.id))).all()]

    # ---- desktop proxy/platform lookup and serialization ----------------------------------
    def get_proxy(self, proxy_id: int | str) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = db.get(Proxy, int(proxy_id))
            return _proxy_dict(item) if item else None

    def get_proxy_model(self, proxy_id: int | str, db: Optional[Session] = None) -> Optional[Proxy]:
        if db is not None:
            return db.get(Proxy, int(proxy_id))
        with self.session() as local:
            return local.get(Proxy, int(proxy_id))

    def list_proxies(self) -> List[Dict[str, Any]]:
        with self.session() as db:
            items = db.scalars(select(Proxy).order_by(desc(Proxy.created_at), desc(Proxy.id))).all()
            return [_proxy_dict(item) for item in items]

    def get_platform(self, platform_id: int | str) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            row = db.execute(
                select(Platform, UploadedFile)
                .outerjoin(UploadedFile, UploadedFile.path == Platform.icon_url)
                .where(Platform.id == int(platform_id))
            ).one_or_none()
            return (
                _platform_dict(row[0], uploaded_file=row[1]) if row else None
            )

    def get_platform_model(self, platform_id: int | str, db: Optional[Session] = None) -> Optional[Platform]:
        if db is not None:
            return db.get(Platform, int(platform_id))
        with self.session() as local:
            return local.get(Platform, int(platform_id))

    def list_platforms(self) -> List[Dict[str, Any]]:
        with self.session() as db:
            rows = db.execute(
                select(Platform, UploadedFile)
                .outerjoin(UploadedFile, UploadedFile.path == Platform.icon_url)
                .order_by(Platform.sort_order, Platform.id)
            ).all()
            return [
                _platform_dict(item, uploaded_file=uploaded_file)
                for item, uploaded_file in rows
            ]

    def _load_user_desktop_snapshot(
        self,
        session: Session,
        user_id: int,
    ) -> Optional[
        Tuple[
            User,
            Optional[Proxy],
            List[Tuple[Platform, Optional[UploadedFile]]],
        ]
    ]:
        """Load a user's assigned proxy and platforms in one SQL snapshot."""
        rows = session.execute(
            select(User, Proxy, Platform, UploadedFile)
            .outerjoin(
                UserProxyAssignment,
                UserProxyAssignment.user_id == User.id,
            )
            .outerjoin(Proxy, Proxy.id == UserProxyAssignment.proxy_id)
            .outerjoin(
                UserPlatformAssignment,
                UserPlatformAssignment.user_id == User.id,
            )
            .outerjoin(Platform, Platform.id == UserPlatformAssignment.platform_id)
            .outerjoin(UploadedFile, UploadedFile.path == Platform.icon_url)
            .where(User.id == user_id, User.deleted_at.is_(None))
            .order_by(Platform.sort_order, Platform.id)
        ).all()
        if not rows:
            return None
        user = rows[0][0]
        proxy = rows[0][1]
        platforms = [
            (row[2], row[3]) for row in rows if row[2] is not None
        ]
        return user, proxy, platforms

    @staticmethod
    def _serialize_user_desktop_snapshot(
        user_id: int,
        proxy: Optional[Proxy],
        platforms: List[Tuple[Platform, Optional[UploadedFile]]],
        *,
        desktop: bool,
    ) -> Dict[str, Any]:
        visible_proxy = proxy
        visible_platforms = platforms
        if desktop:
            if visible_proxy is not None and visible_proxy.status != "active":
                visible_proxy = None
            visible_platforms = [
                item for item in platforms if item[0].status == "active"
            ]

        result: Dict[str, Any] = {
            "proxy": _desktop_proxy_dict(visible_proxy)
            if desktop and visible_proxy is not None
            else (_proxy_dict(visible_proxy) if visible_proxy is not None else None),
            "platforms": [
                _platform_dict(
                    item,
                    desktop=desktop,
                    uploaded_file=uploaded_file,
                )
                for item, uploaded_file in visible_platforms
            ],
        }
        if desktop:
            result["profileKey"] = f"user-{user_id}"
        return result

    def get_user_desktop_config(
        self,
        user_id: int | str,
        *,
        desktop: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Return assignments, filtering disabled resources for desktop users."""
        numeric_user_id = int(user_id)
        with self.session() as session:
            snapshot = self._load_user_desktop_snapshot(session, numeric_user_id)
            if snapshot is None:
                return None
            _user, proxy, platforms = snapshot
            return self._serialize_user_desktop_snapshot(
                numeric_user_id,
                proxy,
                platforms,
                desktop=desktop,
            )

    def get_user_desktop_config_with_lease(
        self,
        user_id: int | str,
    ) -> Optional[Dict[str, Any]]:
        """Serialize desktop configuration and lease from one SQL snapshot."""
        numeric_user_id = int(user_id)
        with self.session() as session:
            snapshot = self._load_user_desktop_snapshot(session, numeric_user_id)
            if snapshot is None:
                return None
            _user, proxy, platforms = snapshot
            result = self._serialize_user_desktop_snapshot(
                numeric_user_id,
                proxy,
                platforms,
                desktop=True,
            )
            result["lease"] = _desktop_lease_from_snapshot(
                numeric_user_id,
                proxy,
                [platform for platform, _uploaded_file in platforms],
            )
            return result

    def get_user_desktop_lease(self, user_id: int | str) -> Optional[str]:
        """Hash all assignment metadata that can change a running desktop route.

        Password changes are represented by a digest of the Fernet ciphertext;
        the plaintext is never decrypted or hashed for lease generation.
        """
        numeric_user_id = int(user_id)
        with self.session() as session:
            snapshot = self._load_user_desktop_snapshot(session, numeric_user_id)
            if snapshot is None:
                return None
            _user, proxy, platforms = snapshot
            return _desktop_lease_from_snapshot(
                numeric_user_id,
                proxy,
                [platform for platform, _uploaded_file in platforms],
            )

    # ---- mutations -------------------------------------------------------------------------
    def insert_admin(self, values: Dict[str, Any]) -> Dict[str, Any]:
        with self.session() as db:
            item = Admin(username=values["username"].strip(), password_hash=hash_password(values["password"]), name=values["name"].strip(), role=values.get("role", "admin"), status=values.get("status", "active"), password_changed_at=utc_now())
            db.add(item)
            db.flush()
            return _admin_dict(item)

    def update_admin(self, admin_id: int | str, values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = db.scalar(select(Admin).where(Admin.id == int(admin_id), Admin.deleted_at.is_(None)).with_for_update())
            if item is None:
                return None
            removes_active_super = (
                item.role == "super_admin"
                and item.status == "active"
                and (values.get("role") == "admin" or values.get("status") == "disabled")
            )
            if removes_active_super:
                active_ids = db.scalars(
                    select(Admin.id)
                    .where(Admin.role == "super_admin", Admin.status == "active", Admin.deleted_at.is_(None))
                    .with_for_update()
                ).all()
                if len(active_ids) <= 1:
                    raise LastSuperAdminError("不能停用或降级唯一的超级管理员")
            for key in ("username", "name", "role", "status"):
                if key in values and values[key] is not None:
                    setattr(item, key, values[key].strip() if isinstance(values[key], str) else values[key])
            if "password" in values and values["password"]:
                item.password_hash = hash_password(values["password"])
                item.password_changed_at = utc_now()
            if any(k in values for k in ("password", "username", "role", "status")):
                item.token_version = int(item.token_version or 1) + 1
            db.flush()
            return _admin_dict(item)

    def insert_user(self, values: Dict[str, Any]) -> Dict[str, Any]:
        with self.session() as db:
            item = User(
                username=values["username"].strip(), password_hash=hash_password(values["password"]), name=values["name"].strip(),
                company=values.get("company"), phone=values.get("phone"), status=values.get("status", "active"),
                expires_at=parse_datetime(values.get("expires_at"), end_of_day=True), max_sessions=int(values.get("max_sessions", 1)),
                created_by=values.get("created_by"), remark=values.get("remark"), must_change_password=bool(values.get("must_change_password", False)),
            )
            db.add(item)
            db.flush()
            return _user_dict(item)

    def insert_proxy(self, values: Dict[str, Any]) -> Dict[str, Any]:
        with self.session() as db:
            item = Proxy(
                name=values["name"].strip(),
                host=values["host"].strip(),
                port=int(values["port"]),
                username=values["username"].strip(),
                encrypted_password=encrypt_proxy_password(values["password"]),
                bypass_hosts=list(values.get("bypass_hosts") or []),
                status=values.get("status", "active"),
            )
            db.add(item)
            db.flush()
            return _proxy_dict(item)

    def update_proxy(self, proxy_id: int | str, values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = db.get(Proxy, int(proxy_id))
            if item is None:
                return None
            for key in ("name", "host", "port", "username", "status"):
                if key not in values:
                    continue
                value = values[key]
                if key in {"name", "host"} and isinstance(value, str):
                    value = value.strip()
                elif key == "username":
                    value = value.strip()
                setattr(item, key, value)
            if "bypass_hosts" in values:
                item.bypass_hosts = list(values["bypass_hosts"] or [])
            if "password" in values and values["password"] is not None:
                item.encrypted_password = encrypt_proxy_password(values["password"])
            item.updated_at = utc_now()
            db.flush()
            return _proxy_dict(item)

    def insert_platform(self, values: Dict[str, Any]) -> Dict[str, Any]:
        with self.session() as db:
            icon_url, uploaded_file = _validated_image_reference(
                db,
                values.get("icon_url") or values.get("iconUrl") or "",
            )
            item = Platform(
                name=values["name"].strip(),
                url=values["url"].strip(),
                icon_url=icon_url or None,
                sort_order=int(values.get("sort_order", values.get("sortOrder", 0))),
                status=values.get("status", "active"),
            )
            db.add(item)
            db.flush()
            return _platform_dict(item, uploaded_file=uploaded_file)

    def update_platform(self, platform_id: int | str, values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = db.get(Platform, int(platform_id))
            if item is None:
                return None
            uploaded_file: Optional[UploadedFile] = None
            mapping = {
                "name": "name",
                "url": "url",
                "icon_url": "icon_url",
                "iconUrl": "icon_url",
                "sort_order": "sort_order",
                "sortOrder": "sort_order",
                "status": "status",
            }
            for key, attr in mapping.items():
                if key in values:
                    value = values[key]
                    if key in {"name", "url"} and isinstance(value, str):
                        value = value.strip()
                    elif key in {"icon_url", "iconUrl"} and isinstance(value, str):
                        normalized, uploaded_file = _validated_image_reference(db, value)
                        value = normalized or None
                    setattr(item, attr, value)
            item.updated_at = utc_now()
            db.flush()
            if "icon_url" not in values and "iconUrl" not in values:
                try:
                    normalized = normalize_upload_reference(item.icon_url or "")
                except ValueError:
                    normalized = ""
                if normalized:
                    uploaded_file = db.scalar(
                        select(UploadedFile).where(UploadedFile.path == normalized)
                    )
            return _platform_dict(item, uploaded_file=uploaded_file)

    def delete_platform(self, platform_id: int | str) -> bool:
        """Delete a platform and clean up legacy user assignments."""
        numeric_id = int(platform_id)
        with self.session() as session:
            item = session.get(Platform, numeric_id)
            if item is None:
                return False
            session.execute(delete(UserPlatformAssignment).where(UserPlatformAssignment.platform_id == numeric_id))
            session.delete(item)
            session.flush()
            return True

    def delete_proxy(self, proxy_id: int | str) -> bool:
        """Delete a proxy and clean up legacy user assignments."""
        numeric_id = int(proxy_id)
        with self.session() as session:
            item = session.get(Proxy, numeric_id)
            if item is None:
                return False
            session.execute(delete(UserProxyAssignment).where(UserProxyAssignment.proxy_id == numeric_id))
            session.delete(item)
            session.flush()
            return True

    def set_user_desktop_config(self, user_id: int | str, proxy_id: Optional[int], platform_ids: Optional[List[int]] = None) -> Dict[str, Any]:
        """Atomically replace a user's proxy and platform assignments."""
        numeric_user_id = int(user_id)
        selected_platform_ids = [int(item) for item in (platform_ids or [])]
        with self.session() as session:
            user = session.scalar(
                select(User).where(User.id == numeric_user_id, User.deleted_at.is_(None)).with_for_update()
            )
            if user is None:
                raise LookupError("用户不存在")

            selected_proxy: Optional[Proxy] = None
            if proxy_id is not None:
                selected_proxy = session.get(Proxy, int(proxy_id))
                if selected_proxy is None:
                    raise ValueError("代理不存在")
                if selected_proxy.status != "active":
                    raise ValueError("只能分配启用状态的代理")

            selected_platforms: List[Platform] = []
            if selected_platform_ids:
                selected_platforms = list(
                    session.scalars(
                        select(Platform).where(Platform.id.in_(selected_platform_ids))
                    ).all()
                )
                if len(selected_platforms) != len(selected_platform_ids):
                    raise ValueError("平台不存在")
                if any(item.status != "active" for item in selected_platforms):
                    raise ValueError("只能分配启用状态的平台")

            session.execute(delete(UserProxyAssignment).where(UserProxyAssignment.user_id == numeric_user_id))
            if selected_proxy is not None:
                session.add(UserProxyAssignment(user_id=numeric_user_id, proxy_id=selected_proxy.id))
            session.execute(
                delete(UserPlatformAssignment).where(
                    UserPlatformAssignment.user_id == numeric_user_id
                )
            )
            for selected_platform_id in selected_platform_ids:
                session.add(
                    UserPlatformAssignment(
                        user_id=numeric_user_id,
                        platform_id=selected_platform_id,
                    )
                )
            session.flush()

        # Serialize in a new session so ordering and public-field rules stay in
        # one code path.
        result = self.get_user_desktop_config(numeric_user_id, desktop=False)
        if result is None:  # The locked user existed during the transaction.
            raise LookupError("用户不存在")
        return result

    def update_user(self, user_id: int | str, values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self.session() as db:
            item = self.get_user_model(user_id, db)
            if item is None:
                return None
            mapping = {"username": "username", "name": "name", "company": "company", "phone": "phone", "status": "status", "max_sessions": "max_sessions", "remark": "remark", "must_change_password": "must_change_password"}
            for key, attr in mapping.items():
                if key in values:
                    value = values[key]
                    setattr(item, attr, value.strip() if isinstance(value, str) and key in {"username", "name"} else value)
            if "expires_at" in values:
                item.expires_at = parse_datetime(values["expires_at"], end_of_day=True)
            if values.get("status") == "active":
                item.failed_login_count = 0
                item.locked_until = None
            if values.get("password"):
                item.password_hash = hash_password(values["password"])
            if any(k in values for k in ("password", "username", "status", "expires_at", "must_change_password")):
                item.token_version = int(item.token_version or 1) + 1
            db.flush()
            return _user_dict(item)

    def soft_delete_user(self, user_id: int | str) -> bool:
        with self.session() as db:
            item = self.get_user_model(user_id, db)
            if item is None:
                return False
            item.deleted_at = utc_now()
            item.status = "disabled"
            item.token_version = int(item.token_version or 1) + 1
            return True

    def soft_delete_admin(self, admin_id: int | str) -> bool:
        with self.session() as db:
            item = self.get_admin_model(admin_id, db)
            if item is None:
                return False
            if item.role == "super_admin" and item.status == "active":
                count = db.scalar(
                    select(func.count(Admin.id))
                    .where(Admin.role == "super_admin", Admin.status == "active", Admin.deleted_at.is_(None))
                ) or 0
                if int(count) <= 1:
                    raise LastSuperAdminError("不能删除系统中唯一的激活超级管理员")
            item.deleted_at = utc_now()
            item.status = "disabled"
            item.token_version = int(item.token_version or 1) + 1
            return True

    def set_admin_status(self, admin_id: int | str, status_value: str) -> Optional[Dict[str, Any]]:
        return self.update_admin(admin_id, {"status": status_value})

    def set_user_status(self, user_id: int | str, status_value: str) -> Optional[Dict[str, Any]]:
        return self.update_user(user_id, {"status": status_value})

    # ---- login state and logs ---------------------------------------------------------------
    def mark_admin_login(self, admin_id: int | str, ip: Optional[str]) -> None:
        with self.session() as db:
            item = self.get_admin_model(admin_id, db)
            if item:
                item.last_login_at, item.last_login_ip = utc_now(), ip_bytes(ip)

    def mark_user_login(self, user_id: int | str, ip: Optional[str]) -> None:
        with self.session() as db:
            item = self.get_user_model(user_id, db)
            if item:
                item.last_login_at, item.last_login_ip, item.failed_login_count = utc_now(), ip_bytes(ip), 0
                item.locked_until = None

    def record_failed_login(self, account_type: str, account_id: int | str, *, max_attempts: int = 5, lock_minutes: int = 15) -> None:
        if account_type == "user":
            with self.session() as db:
                item = self.get_user_model(account_id, db)
                if item:
                    item.failed_login_count = int(item.failed_login_count or 0) + 1
                    if item.failed_login_count >= max(int(max_attempts), 1):
                        item.locked_until = utc_now() + timedelta(minutes=max(int(lock_minutes), 1))

    def bump_token_version(self, account_type: str, account_id: int | str) -> None:
        with self.session() as db:
            model = Admin if account_type == "admin" else User
            item = db.scalar(select(model).where(model.id == int(account_id), model.deleted_at.is_(None)))
            if item:
                item.token_version = int(item.token_version or 1) + 1

    def add_log(self, *, actor_type: str, actor_id: Optional[int] = None, actor_username: Optional[str] = None, actor_role: Optional[str] = None, action: str, summary: str, ip: Optional[str] = None, user_agent: Optional[str] = None, status: str = "SUCCESS", target_type: Optional[str] = None, target_id: Optional[int] = None, target_name: Optional[str] = None, details: Optional[Dict[str, Any]] = None, request_id: Optional[str] = None) -> Dict[str, Any]:
        with self.session() as db:
            item = UserLog(request_id=request_id or str(uuid.uuid4()), actor_type=actor_type, actor_id=actor_id, actor_username=actor_username, actor_role=actor_role, action=action, target_type=target_type, target_id=target_id, target_name=target_name, summary=summary[:500], ip_address=ip_bytes(ip), user_agent=(user_agent or "")[:512] or None, status=status, details=details)
            db.add(item)
            db.flush()
            return _log_dict(item)

    def list_logs(self, *, page: int = 1, page_size: int = 50, actor_type: Optional[str] = None, actor_id: Optional[int] = None, action: Optional[str] = None, status: Optional[str] = None, target_id: Optional[int] = None, start_at: Any = None, end_at: Any = None) -> Tuple[List[Dict[str, Any]], int]:
        page, page_size = max(int(page), 1), min(max(int(page_size), 1), 200)
        with self.session() as db:
            conditions = []
            if actor_type: conditions.append(UserLog.actor_type == actor_type)
            if actor_id is not None: conditions.append(UserLog.actor_id == actor_id)
            if action: conditions.append(UserLog.action == action)
            if status: conditions.append(UserLog.status == status)
            if target_id is not None: conditions.append(UserLog.target_id == target_id)
            if start_at: conditions.append(UserLog.created_at >= parse_datetime(start_at))
            if end_at: conditions.append(UserLog.created_at <= parse_datetime(end_at, end_of_day=True))
            where = and_(*conditions) if conditions else None
            count_stmt = select(func.count(UserLog.id))
            if where is not None:
                count_stmt = count_stmt.where(where)
            total = int(db.scalar(count_stmt) or 0)
            stmt = select(UserLog).order_by(desc(UserLog.created_at), desc(UserLog.id)).offset((page - 1) * page_size).limit(page_size)
            if where is not None: stmt = stmt.where(where)
            return [_log_dict(x) for x in db.scalars(stmt).all()], total

    def stats(self) -> Dict[str, int]:
        with self.session() as db:
            now = utc_now()
            rows = db.execute(
                select(User.status, func.count(User.id))
                .where(User.deleted_at.is_(None), or_(User.expires_at.is_(None), User.expires_at > now))
                .group_by(User.status)
            ).all()
            result: Dict[str, int] = {"total": 0, "active": 0, "disabled": 0, "locked": 0, "expired": 0}
            for key, count in rows:
                result[str(key)] = int(count)
                result["total"] += int(count)
            expired_count = int(
                db.scalar(select(func.count(User.id)).where(User.deleted_at.is_(None), User.expires_at.is_not(None), User.expires_at <= now)) or 0
            )
            result["expired"] = expired_count
            result["total"] += expired_count
            return result

    def get_setting(self, key: str, default: str = "") -> str:
        with self.session() as s:
            item = s.scalar(select(SystemSetting).where(SystemSetting.key == key))
            return item.value if item else default

    def set_setting(self, key: str, value: str) -> None:
        with self.session() as s:
            item = s.scalar(select(SystemSetting).where(SystemSetting.key == key))
            if item:
                item.value = value
                item.updated_at = utc_now()
            else:
                item = SystemSetting(key=key, value=value, updated_at=utc_now())
                s.add(item)
            s.commit()

    def get_branding(self) -> Dict[str, str]:
        env_product = os.getenv("VESTUS_PRODUCT_NAME", "Vestus").strip() or "Vestus"
        name = self.get_setting("product_name", env_product)
        logo = self.get_setting("product_logo", "")
        admin_title = self.get_setting("admin_title", "Vestus Admin")
        admin_logo = self.get_setting("admin_logo", "")
        admin_theme_color = self.get_setting("admin_theme_color", "blue")
        references = {value for value in (logo, admin_logo) if value}
        uploaded_files: Dict[str, UploadedFile] = {}
        if references:
            with self.session() as db:
                uploaded_files = {
                    item.path: item
                    for item in db.scalars(
                        select(UploadedFile).where(UploadedFile.path.in_(references))
                    ).all()
                }
        logo = _safe_image_reference(logo, uploaded_files.get(logo))
        admin_logo = _safe_image_reference(
            admin_logo, uploaded_files.get(admin_logo)
        )
        return {
            "productName": name if name else env_product,
            "logoUrl": logo,
            "adminTitle": admin_title if admin_title else "Vestus Admin",
            "adminLogoUrl": admin_logo,
            "adminThemeColor": admin_theme_color if admin_theme_color else "blue",
        }

    def set_branding(
        self,
        product_name: Optional[str] = None,
        logo_url: Optional[str] = None,
        admin_title: Optional[str] = None,
        admin_logo_url: Optional[str] = None,
        admin_theme_color: Optional[str] = None,
    ) -> Dict[str, str]:
        normalized_logo = logo_url
        normalized_admin_logo = admin_logo_url
        if logo_url is not None or admin_logo_url is not None:
            with self.session() as db:
                if logo_url is not None:
                    normalized_logo, _uploaded_file = _validated_image_reference(
                        db, logo_url
                    )
                if admin_logo_url is not None:
                    normalized_admin_logo, _uploaded_file = _validated_image_reference(
                        db, admin_logo_url
                    )
        if product_name is not None:
            self.set_setting("product_name", product_name.strip())
        if logo_url is not None:
            self.set_setting("product_logo", normalized_logo or "")
        if admin_title is not None:
            self.set_setting("admin_title", admin_title.strip())
        if admin_logo_url is not None:
            self.set_setting("admin_logo", normalized_admin_logo or "")
        if admin_theme_color is not None:
            self.set_setting("admin_theme_color", admin_theme_color.strip())
        return self.get_branding()


__all__ = [
    "Base", "Admin", "User", "UserLog", "Proxy", "Platform", "UploadedFile",
    "UserProxyAssignment", "UserPlatformAssignment", "SystemSetting", "Database",
    "LastSuperAdminError", "utc_now", "iso_datetime", "parse_datetime",
    "IntegrityError", "OperationalError",
]
