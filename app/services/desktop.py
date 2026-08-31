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

import logging
from typing import Any, Dict, List, Optional, Tuple

from app.db.models import Platform, Proxy, UploadedFile
from app.db.session import Database
from app.repositories import desktop as desktop_repo
from app.schemas.serializers import (
    desktop_lease_from_snapshot,
    desktop_proxy_dict,
    platform_dict,
)
from app.services.errors import CredentialUnreadableError

logger = logging.getLogger(__name__)

MISSING_USER_DETAIL = "用户不存在"
UNREADABLE_PROXY_DETAIL = "代理凭据不可用，请联系管理员在后台重新保存该代理的密码"


def _desktop_proxy(proxy: Proxy) -> Dict[str, Any]:
    """Serialize the proxy credential, naming the failure an operator can fix.

    ``decrypt_proxy_password`` raises ``ValueError`` when the ciphertext was
    written under a different key -- a rotated ``VESTUS_PROXY_SECRET_KEY``, or a
    row from the pre-refactor build's per-process random fallback.  Re-saving the
    password is the only fix, so say that instead of failing as a bare 500.
    """

    try:
        return desktop_proxy_dict(proxy)
    except ValueError as exc:
        logger.error("proxy %s credential does not decrypt with the configured key", proxy.id)
        raise CredentialUnreadableError(UNREADABLE_PROXY_DETAIL) from exc


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
        "proxy": _desktop_proxy(visible_proxy) if visible_proxy is not None else None,
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
