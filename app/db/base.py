"""Declarative base, shared column types and datetime/IP helpers.

This module is the bottom of the dependency graph: it must not import anything
from ``app`` other than the standard library and SQLAlchemy, so both the ORM
models and the Alembic environment can import it safely.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from ipaddress import ip_address
from typing import Any, Optional

from sqlalchemy import BigInteger, DateTime, Integer
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.orm import DeclarativeBase


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


#: MySQL wants BIGINT surrogate keys; SQLite has no BIGINT AUTOINCREMENT.
IdType = BigInteger().with_variant(Integer, "sqlite")
#: Microsecond precision matters: desktop config leases hash ``updated_at``.
DateTime6 = MySQLDateTime(fsp=6).with_variant(DateTime(), "sqlite")

TABLE_ARGS = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

__all__ = [
    "Base",
    "DateTime6",
    "IdType",
    "TABLE_ARGS",
    "ip_bytes",
    "ip_text",
    "iso_datetime",
    "parse_datetime",
    "utc_now",
]
