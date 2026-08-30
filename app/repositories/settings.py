"""System-setting queries.

``upsert`` deliberately does **not** commit: branding writes several keys and
must land atomically, which the previous per-key commit made impossible.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.base import utc_now
from app.db.models import SystemSetting


def get_value(session: Session, key: str, default: str = "") -> str:
    item = session.scalar(select(SystemSetting).where(SystemSetting.key == key))
    return item.value if item else default


def find(session: Session, key: str) -> Optional[SystemSetting]:
    return session.scalar(select(SystemSetting).where(SystemSetting.key == key))


def upsert(session: Session, key: str, value: str) -> SystemSetting:
    item = session.scalar(select(SystemSetting).where(SystemSetting.key == key))
    if item is not None:
        item.value = value
        item.updated_at = utc_now()
        return item
    item = SystemSetting(key=key, value=value, updated_at=utc_now())
    session.add(item)
    return item
