"""Desktop FAQ content: groups of Q&A items shown in the client's help menu."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now

#: Availability states, mirroring the ``platform`` table convention.  A
#: disabled row stays editable in the admin console but is never serialized
#: to the desktop client.
STATUS_ACTIVE = "active"
STATUS_DISABLED = "disabled"


class DesktopFaqGroup(Base):
    """A help-document section, e.g. 《三、多个方舟账号》."""

    __tablename__ = "desktop_faq_group"
    __table_args__ = ({**TABLE_ARGS},)

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_ACTIVE, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)


class DesktopFaqItem(Base):
    """One Q&A entry, e.g. 「Q10：…」 plus its plain-text answer."""

    __tablename__ = "desktop_faq_item"
    __table_args__ = ({**TABLE_ARGS},)

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    # No SQL-level FK anywhere in this schema; deleting a group removes its
    # items in the same application-level transaction (see the service layer).
    group_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    question: Mapped[str] = mapped_column(String(255), nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_ACTIVE, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, onupdate=utc_now)


__all__ = ["STATUS_ACTIVE", "STATUS_DISABLED", "DesktopFaqGroup", "DesktopFaqItem"]
