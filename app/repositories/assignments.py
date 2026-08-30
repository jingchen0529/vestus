"""Legacy per-user assignment writes.

The HTTP API no longer reads these tables; the writer is retained so an
existing integration that still calls the deprecated endpoint keeps working.
"""

from __future__ import annotations

from typing import Sequence

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.db.models import UserPlatformAssignment, UserProxyAssignment


def replace_for_user(
    session: Session,
    user_id: int,
    proxy_id: int | None,
    platform_ids: Sequence[int],
) -> None:
    session.execute(delete(UserProxyAssignment).where(UserProxyAssignment.user_id == user_id))
    if proxy_id is not None:
        session.add(UserProxyAssignment(user_id=user_id, proxy_id=proxy_id))
    session.execute(delete(UserPlatformAssignment).where(UserPlatformAssignment.user_id == user_id))
    for platform_id in platform_ids:
        session.add(UserPlatformAssignment(user_id=user_id, platform_id=platform_id))
    session.flush()
