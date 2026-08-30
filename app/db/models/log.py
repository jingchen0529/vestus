"""The single audit trail for both administrators and desktop users."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import JSON, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class UserLog(Base):
    __tablename__ = "user_log"
    __table_args__ = ({**TABLE_ARGS},)

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
