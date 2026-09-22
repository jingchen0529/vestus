"""An administrator-managed upstream proxy (VPN node)."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import JSON, Boolean, Integer, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class Proxy(Base):
    """An administrator-managed upstream proxy.

    Several proxies may be ``active`` at once: each desktop user can be pointed
    at its own node through ``User.proxy_id``.  Exactly one proxy carries the
    ``is_default`` mark; users without an explicit assignment -- and users whose
    assigned node is missing or disabled -- resolve to it.

    The credential is never serialized directly.  ``encrypted_password`` is
    a Fernet token, not a password hash, because the desktop client must be
    able to receive the original credential after authenticating.
    """

    __tablename__ = "proxy"
    __table_args__ = (
        UniqueConstraint("name", name="uq_proxy_name"),
        {**TABLE_ARGS},
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
    #: The fallback node for users without their own assignment.  At most one
    #: row may carry this mark; the service layer clears the previous holder.
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)
