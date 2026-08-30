"""The single-statement desktop configuration snapshot.

One SELECT loads the user row, the globally active proxy and every active
platform (with its icon).  Keeping it to one statement is asserted by the test
suite: a lease read must not fan out into per-platform queries.
"""

from __future__ import annotations

from typing import List, Optional, Set, Tuple

from sqlalchemy import desc, select
from sqlalchemy.orm import Session, aliased

from app.db.models import Platform, Proxy, UploadedFile, User

DesktopSnapshot = Tuple[User, Optional[Proxy], List[Tuple[Platform, Optional[UploadedFile]]]]


def load_user_snapshot(session: Session, user_id: int) -> Optional[DesktopSnapshot]:
    """Load the global active proxy and platforms for one desktop user.

    The user remains part of the snapshot so deleted accounts cannot obtain
    configuration and each response can retain its user-scoped profile key.
    Legacy assignment rows are intentionally ignored.
    """
    active_proxy = aliased(Proxy)
    active_proxy_id = (
        select(active_proxy.id)
        .where(active_proxy.status == "active")
        .order_by(desc(active_proxy.updated_at), desc(active_proxy.id))
        .limit(1)
        .scalar_subquery()
    )
    rows = session.execute(
        select(User, Proxy, Platform, UploadedFile)
        .select_from(User)
        .outerjoin(
            Proxy,
            Proxy.id == active_proxy_id,
        )
        .outerjoin(
            Platform,
            Platform.status == "active",
        )
        .outerjoin(UploadedFile, UploadedFile.path == Platform.icon_url)
        .where(User.id == user_id, User.deleted_at.is_(None))
        .order_by(
            desc(Proxy.updated_at),
            desc(Proxy.id),
            Platform.sort_order,
            Platform.id,
        )
    ).all()
    if not rows:
        return None
    user = rows[0][0]
    proxy = rows[0][1]
    platforms: List[Tuple[Platform, Optional[UploadedFile]]] = []
    seen_platform_ids: Set[int] = set()
    for row in rows:
        platform = row[2]
        if platform is None or platform.id in seen_platform_ids:
            continue
        seen_platform_ids.add(platform.id)
        platforms.append((platform, row[3]))
    return user, proxy, platforms
