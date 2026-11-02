"""Queries for managed platform accounts and one-time browser grants."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional, cast

from sqlalchemy import CursorResult, select
from sqlalchemy.orm import Session

from app.db.models import ManagedBrowserSession, ManagedPlatformAccount, ManagedPlatformBinding


def get_account(session: Session, account_id: int | str) -> Optional[ManagedPlatformAccount]:
    return session.get(ManagedPlatformAccount, int(account_id))


def list_accounts(session: Session) -> list[ManagedPlatformAccount]:
    return list(
        session.scalars(
            select(ManagedPlatformAccount).order_by(
                ManagedPlatformAccount.platform_id, ManagedPlatformAccount.id
            )
        ).all()
    )


def get_binding(
    session: Session, user_id: int | str, platform_id: int | str
) -> Optional[ManagedPlatformBinding]:
    return session.scalar(
        select(ManagedPlatformBinding).where(
            ManagedPlatformBinding.user_id == int(user_id),
            ManagedPlatformBinding.platform_id == int(platform_id),
        )
    )


def get_binding_for_update(
    session: Session, user_id: int | str, platform_id: int | str
) -> Optional[ManagedPlatformBinding]:
    return session.scalar(
        select(ManagedPlatformBinding)
        .where(
            ManagedPlatformBinding.user_id == int(user_id),
            ManagedPlatformBinding.platform_id == int(platform_id),
        )
        .with_for_update()
    )


def get_binding_account(
    session: Session, user_id: int | str, platform_id: int | str
) -> Optional[tuple[ManagedPlatformBinding, ManagedPlatformAccount]]:
    binding = get_binding(session, user_id, platform_id)
    if binding is None:
        return None
    account = get_account(session, binding.managed_account_id)
    if account is None:
        return None
    return binding, account


def get_session_for_update(session: Session, grant_hash: str) -> Optional[ManagedBrowserSession]:
    return session.scalar(
        select(ManagedBrowserSession)
        .where(ManagedBrowserSession.grant_hash == grant_hash)
        .with_for_update()
    )


def purge_expired_sessions(session: Session, now: datetime) -> int:
    from sqlalchemy import delete

    result = cast(
        CursorResult[Any],
        session.execute(
            delete(ManagedBrowserSession).where(
                ManagedBrowserSession.expires_at < now,
                ManagedBrowserSession.consumed_at.is_not(None),
            )
        ),
    )
    return int(result.rowcount or 0)


__all__ = [
    "get_account",
    "get_binding",
    "get_binding_account",
    "get_binding_for_update",
    "get_session_for_update",
    "list_accounts",
    "purge_expired_sessions",
]
