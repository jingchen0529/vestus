"""Queries for managed platform accounts and one-time browser grants."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional, cast

from sqlalchemy import CursorResult, or_, select, update
from sqlalchemy.orm import Session

from app.db.models import ManagedBrowserSession, ManagedPlatformAccount, ManagedPlatformBinding, Platform


def get_account(session: Session, account_id: int | str) -> Optional[ManagedPlatformAccount]:
    return session.get(ManagedPlatformAccount, int(account_id))


def get_account_for_update(session: Session, account_id: int | str) -> Optional[ManagedPlatformAccount]:
    # Lock order across managed operations is grant -> binding -> account.
    # Refresh cached ORM rows as well: an earlier non-locking read may be stale.
    return session.scalar(
        select(ManagedPlatformAccount)
        .where(ManagedPlatformAccount.id == int(account_id))
        .with_for_update()
        .execution_options(populate_existing=True)
    )


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
        ).order_by(ManagedPlatformBinding.id)
    )


def list_bindings(
    session: Session, user_id: int | str, platform_id: int | str
) -> list[ManagedPlatformBinding]:
    return list(
        session.scalars(
            select(ManagedPlatformBinding)
            .where(
                ManagedPlatformBinding.user_id == int(user_id),
                ManagedPlatformBinding.platform_id == int(platform_id),
            )
            .order_by(ManagedPlatformBinding.id)
        ).all()
    )


def list_bindings_for_user(
    session: Session, user_id: int | str
) -> list[ManagedPlatformBinding]:
    return list(
        session.scalars(
            select(ManagedPlatformBinding)
            .where(ManagedPlatformBinding.user_id == int(user_id))
            .order_by(ManagedPlatformBinding.platform_id, ManagedPlatformBinding.id)
        ).all()
    )


def list_all_bindings(session: Session) -> list[ManagedPlatformBinding]:
    """全部用户的全量绑定，供管理端「绑定托管」总览页使用。"""
    return list(
        session.scalars(
            select(ManagedPlatformBinding).order_by(
                ManagedPlatformBinding.platform_id, ManagedPlatformBinding.user_id,
                ManagedPlatformBinding.id,
            )
        ).all()
    )


def get_binding_for_account(
    session: Session,
    user_id: int | str,
    platform_id: int | str,
    managed_account_id: int | str,
) -> Optional[ManagedPlatformBinding]:
    return session.scalar(
        select(ManagedPlatformBinding).where(
            ManagedPlatformBinding.user_id == int(user_id),
            ManagedPlatformBinding.platform_id == int(platform_id),
            ManagedPlatformBinding.managed_account_id == int(managed_account_id),
        )
    )


def get_binding_for_account_for_update(
    session: Session,
    user_id: int | str,
    platform_id: int | str,
    managed_account_id: int | str,
) -> Optional[ManagedPlatformBinding]:
    return session.scalar(
        select(ManagedPlatformBinding)
        .where(
            ManagedPlatformBinding.user_id == int(user_id),
            ManagedPlatformBinding.platform_id == int(platform_id),
            ManagedPlatformBinding.managed_account_id == int(managed_account_id),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
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
        .order_by(ManagedPlatformBinding.id)
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
        .execution_options(populate_existing=True)
    )


def get_session_by_id_for_update(session: Session, session_id: int | str) -> Optional[ManagedBrowserSession]:
    return session.scalar(
        select(ManagedBrowserSession)
        .where(ManagedBrowserSession.id == int(session_id))
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def consume_session(session: Session, row: ManagedBrowserSession, now: datetime) -> bool:
    """Consume once, even on SQLite where SELECT FOR UPDATE is a no-op.

    Recheck authorization and the credential snapshot in the write itself;
    concurrent expiry/rotation/unbinding must not release stale credentials.
    """
    active_binding = select(ManagedPlatformBinding.id).where(
        ManagedPlatformBinding.user_id == row.user_id,
        ManagedPlatformBinding.platform_id == row.platform_id,
        ManagedPlatformBinding.managed_account_id == row.managed_account_id,
        ManagedPlatformBinding.status == "active",
    ).exists()
    active_account = select(ManagedPlatformAccount.id).where(
        ManagedPlatformAccount.id == row.managed_account_id,
        ManagedPlatformAccount.platform_id == row.platform_id,
        ManagedPlatformAccount.credential_version == row.credential_version,
        ManagedPlatformAccount.status == "active",
        ManagedPlatformAccount.session_status == "valid",
        or_(ManagedPlatformAccount.expires_at.is_(None), ManagedPlatformAccount.expires_at > now),
    ).exists()
    active_platform = select(Platform.id).where(
        Platform.id == row.platform_id, Platform.status == "active"
    ).exists()
    result = cast(
        CursorResult[Any],
        session.execute(
            update(ManagedBrowserSession)
            .where(
                ManagedBrowserSession.id == row.id,
                ManagedBrowserSession.consumed_at.is_(None),
                ManagedBrowserSession.expires_at > now,
                active_binding,
                active_account,
                active_platform,
            )
            .values(consumed_at=now)
            .execution_options(synchronize_session=False)
        ),
    )
    return result.rowcount == 1


def expire_account_session(
    session: Session,
    *,
    account_id: int,
    platform_id: int,
    user_id: int,
    credential_version: int,
    now: datetime,
    last_error: str,
) -> bool:
    """Expire only the reported version; never overwrite a newer credential."""
    active_binding = select(ManagedPlatformBinding.id).where(
        ManagedPlatformBinding.user_id == user_id,
        ManagedPlatformBinding.platform_id == platform_id,
        ManagedPlatformBinding.managed_account_id == account_id,
        ManagedPlatformBinding.status == "active",
    ).exists()
    result = cast(
        CursorResult[Any],
        session.execute(
            update(ManagedPlatformAccount)
            .where(
                ManagedPlatformAccount.id == account_id,
                ManagedPlatformAccount.platform_id == platform_id,
                ManagedPlatformAccount.credential_version == credential_version,
                ManagedPlatformAccount.session_status == "valid",
                ManagedPlatformAccount.status == "active",
                or_(ManagedPlatformAccount.expires_at.is_(None), ManagedPlatformAccount.expires_at > now),
                active_binding,
            )
            .values(
                session_status="expired",
                credential_version=ManagedPlatformAccount.credential_version + 1,
                last_error=last_error,
                updated_at=now,
            )
            .execution_options(synchronize_session=False)
        ),
    )
    return result.rowcount == 1


def purge_expired_sessions(session: Session, now: datetime) -> int:
    """Drop unconsumed, expired grants, not evidence of running sessions.

    expires_at is the redemption deadline, not a browser-session lifetime.
    Consumed rows must remain available for authenticated expiry reports.
    """
    from sqlalchemy import delete

    result = cast(
        CursorResult[Any],
        session.execute(
            delete(ManagedBrowserSession).where(
                ManagedBrowserSession.expires_at <= now,
                ManagedBrowserSession.consumed_at.is_(None),
            )
        ),
    )
    return int(result.rowcount or 0)


__all__ = [
    "consume_session",
    "expire_account_session",
    "get_account",
    "get_account_for_update",
    "get_binding",
    "get_binding_for_account",
    "get_binding_for_account_for_update",
    "get_binding_account",
    "get_binding_for_update",
    "get_session_for_update",
    "get_session_by_id_for_update",
    "list_accounts",
    "list_all_bindings",
    "list_bindings",
    "list_bindings_for_user",
    "purge_expired_sessions",
]
