"""Desktop configuration reads.

Both entry points serialize from the same one-statement snapshot
(:func:`app.repositories.desktop.load_user_snapshot`), so a configuration read
and a lease read can never disagree about what the desktop client should be
running.

Nothing here writes an audit row: the caller records ``DESKTOP_CONFIG_READ``
outside the read transaction, because a read must not be rolled back by a
failing log insert.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from app.db.models import Platform, Proxy, UploadedFile
from app.db.session import Database
from app.repositories import desktop as desktop_repo
from app.schemas.serializers import (
    desktop_lease_from_snapshot,
    desktop_proxy_dict,
    platform_dict,
)

MISSING_USER_DETAIL = "用户不存在"


def _serialize(
    user_id: int,
    proxy: Optional[Proxy],
    platforms: List[Tuple[Platform, Optional[UploadedFile]]],
) -> Dict[str, Any]:
    """Shape the desktop payload, re-checking the ``active`` status defensively.

    The snapshot query already filters on ``active``, but a resource that was
    disabled between the query and this call must not be handed to the client.
    """

    visible_proxy = proxy if proxy is not None and proxy.status == "active" else None
    visible_platforms = [item for item in platforms if item[0].status == "active"]
    return {
        "proxy": desktop_proxy_dict(visible_proxy) if visible_proxy is not None else None,
        "platforms": [
            platform_dict(item, desktop=True, uploaded_file=uploaded_file)
            for item, uploaded_file in visible_platforms
        ],
        "profileKey": f"user-{user_id}",
    }


def get_user_desktop_config_with_lease(
    database: Database, user_id: int | str
) -> Optional[Dict[str, Any]]:
    """Serialize desktop configuration and lease from one SQL snapshot."""

    numeric_user_id = int(user_id)
    with database.session() as session:
        snapshot = desktop_repo.load_user_snapshot(session, numeric_user_id)
        if snapshot is None:
            return None
        _user, proxy, platforms = snapshot
        result = _serialize(numeric_user_id, proxy, platforms)
        result["lease"] = desktop_lease_from_snapshot(
            numeric_user_id, proxy, [platform for platform, _uploaded_file in platforms]
        )
        return result


def get_user_desktop_lease(database: Database, user_id: int | str) -> Optional[str]:
    """Hash all global resource metadata that can change a desktop route.

    Password changes are represented by a digest of the Fernet ciphertext; the
    plaintext is never decrypted or hashed for lease generation.
    """

    numeric_user_id = int(user_id)
    with database.session() as session:
        snapshot = desktop_repo.load_user_snapshot(session, numeric_user_id)
        if snapshot is None:
            return None
        _user, proxy, platforms = snapshot
        return desktop_lease_from_snapshot(
            numeric_user_id, proxy, [platform for platform, _uploaded_file in platforms]
        )


__all__ = ["get_user_desktop_config_with_lease", "get_user_desktop_lease"]
