"""Legacy per-user assignment tables.

Kept for backwards compatibility only: the HTTP API neither reads nor writes
these tables since desktop configuration became global.  They are still part of
``Base.metadata`` so existing databases keep validating against the ORM.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class UserProxyAssignment(Base):
    __tablename__ = "user_proxy_assignment"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_user_proxy_assignment_user"),
        {**TABLE_ARGS},
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
        {**TABLE_ARGS},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    platform_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
