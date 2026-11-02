"""Administrator-managed upstream platform accounts.

The reversible fields in this module are encrypted Fernet payloads.  They are
never serialized by the normal platform/user serializers; only the one-time
bootstrap consume path decrypts the cookie bundle for the Rust client.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import JSON, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class ManagedPlatformAccount(Base):
    __tablename__ = "managed_platform_account"
    __table_args__ = (
        UniqueConstraint("platform_id", "name", name="uq_managed_platform_account_name"),
        {**TABLE_ARGS},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    platform_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    auth_mode: Mapped[str] = mapped_column(String(24), nullable=False, default="cookie")
    encrypted_username: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    encrypted_password: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    encrypted_cookie_bundle: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    # New administrator-managed credentials are intentionally plaintext per the
    # product requirement. The encrypted columns above remain for legacy rows.
    username: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    password: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    cookie_bundle: Mapped[Optional[List[dict]]] = mapped_column(JSON, nullable=True)
    allowed_hosts: Mapped[List[str]] = mapped_column(JSON, nullable=False, default=list)
    credential_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    last_verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(IdType, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime6, nullable=False, default=utc_now, onupdate=utc_now
    )


class ManagedPlatformBinding(Base):
    __tablename__ = "managed_platform_binding"
    __table_args__ = (
        UniqueConstraint("user_id", "platform_id", name="uq_managed_binding_user_platform"),
        {**TABLE_ARGS},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    platform_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    managed_account_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime6, nullable=False, default=utc_now, onupdate=utc_now
    )


class ManagedBrowserSession(Base):
    """One-time server-side bootstrap grant for a managed browser."""

    __tablename__ = "managed_browser_session"
    __table_args__ = (
        UniqueConstraint("grant_hash", name="uq_managed_browser_session_grant"),
        {**TABLE_ARGS},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    grant_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    platform_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    managed_account_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    credential_version: Mapped[int] = mapped_column(Integer, nullable=False)
    device_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, index=True)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime6, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)


__all__ = [
    "ManagedBrowserSession",
    "ManagedPlatformAccount",
    "ManagedPlatformBinding",
]
