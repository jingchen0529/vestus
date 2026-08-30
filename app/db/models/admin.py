"""Web administration accounts."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class Admin(Base):
    __tablename__ = "admin"
    __table_args__ = (
        UniqueConstraint("username", name="uq_admin_username"),
        {**TABLE_ARGS},
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
