"""Conditional claims for durable, account-scoped login recovery jobs."""

from __future__ import annotations

from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, and_, or_, select, update
from sqlalchemy.orm import Session

from app.db.models import ManagedPlatformAccount, Platform


def _eligible(now: datetime) -> Any:
    return and_(
        ManagedPlatformAccount.auth_mode == "server_login",
        ManagedPlatformAccount.auto_relogin.is_(True),
        ManagedPlatformAccount.status == "active",
        or_(ManagedPlatformAccount.expires_at.is_(None), ManagedPlatformAccount.expires_at > now),
        select(Platform.id).where(
            Platform.id == ManagedPlatformAccount.platform_id, Platform.status == "active"
        ).exists(),
    )


def _due(now: datetime) -> Any:
    return or_(
        and_(
            ManagedPlatformAccount.recovery_status.in_(("pending", "retry_wait")),
            or_(ManagedPlatformAccount.next_recovery_at.is_(None), ManagedPlatformAccount.next_recovery_at <= now),
        ),
        and_(
            ManagedPlatformAccount.recovery_status == "running",
            ManagedPlatformAccount.recovery_lease_until <= now,
        ),
        and_(
            ManagedPlatformAccount.recovery_status == "idle",
            or_(
                ManagedPlatformAccount.session_status == "expired",
                and_(
                    ManagedPlatformAccount.cookie_bundle.is_(None),
                    ManagedPlatformAccount.encrypted_cookie_bundle.is_(None),
                ),
            ),
        ),
    )


def due_accounts(session: Session, now: datetime, limit: int = 2) -> list[int]:
    return list(session.scalars(
        select(ManagedPlatformAccount.id)
        .where(_eligible(now), _due(now))
        .order_by(ManagedPlatformAccount.next_recovery_at, ManagedPlatformAccount.id)
        .limit(limit)
    ))


def claim(
    session: Session, account_id: int, now: datetime, lease_until: datetime, token: str, max_attempts: int
) -> ManagedPlatformAccount | None:
    result = cast(CursorResult[Any], session.execute(
        update(ManagedPlatformAccount)
        .where(
            ManagedPlatformAccount.id == account_id, _eligible(now), _due(now),
            ManagedPlatformAccount.recovery_attempts < max_attempts,
        )
        .values(
            recovery_status="running", recovery_lease_token=token, recovery_lease_until=lease_until,
            recovery_attempts=ManagedPlatformAccount.recovery_attempts + 1,
            session_status="expired", next_recovery_at=None, updated_at=now,
        )
        .execution_options(synchronize_session=False)
    ))
    if result.rowcount != 1:
        # A crashed final attempt must not leave the row permanently running.
        session.execute(
            update(ManagedPlatformAccount)
            .where(
                ManagedPlatformAccount.id == account_id, _eligible(now), _due(now),
                ManagedPlatformAccount.recovery_attempts >= max_attempts,
            )
            .values(
                recovery_status="failed", recovery_lease_token=None, recovery_lease_until=None,
                next_recovery_at=None, last_error="自动登录已达到重试上限，请检查账号凭据", updated_at=now,
            )
        )
        return None
    return session.scalar(select(ManagedPlatformAccount).where(
        ManagedPlatformAccount.id == account_id
    ).execution_options(populate_existing=True))


def finish(
    session: Session, account_id: int, version: int, token: str, now: datetime, values: dict[str, Any]
) -> bool:
    result = cast(CursorResult[Any], session.execute(
        update(ManagedPlatformAccount)
        .where(
            ManagedPlatformAccount.id == account_id, _eligible(now),
            ManagedPlatformAccount.credential_version == version,
            ManagedPlatformAccount.recovery_status == "running",
            ManagedPlatformAccount.recovery_lease_token == token,
            ManagedPlatformAccount.recovery_lease_until > now,
        )
        .values(**values, recovery_lease_token=None, recovery_lease_until=None, updated_at=now)
        .execution_options(synchronize_session=False)
    ))
    return result.rowcount == 1
