"""ORM -> JSON serializers shared by routers and services.

Every function here is pure: it reads an already-loaded ORM instance and never
touches a ``Session``.  That keeps the desktop/admin response shapes in one
place while leaving all querying to :mod:`app.repositories`.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

from app.core.security import decrypt_proxy_password
from app.core.uploads import is_inline_safe, normalize_upload_reference
from app.db.base import ip_text, iso_datetime
from app.db.models import Admin, Platform, Proxy, UploadedFile, User, UserLog


def admin_dict(item: Admin) -> Dict[str, Any]:
    return {
        "id": item.id,
        "username": item.username,
        "name": item.name,
        "role": item.role,
        "status": item.status,
        "lastLoginAt": iso_datetime(item.last_login_at),
        "createdAt": iso_datetime(item.created_at),
        "updatedAt": iso_datetime(item.updated_at),
    }


def user_dict(item: User) -> Dict[str, Any]:
    # The first desktop client accepts a calendar date. Keep the storage
    # precision in MySQL while exposing the stable date-shaped contract.
    expires_value = item.expires_at.date().isoformat() if item.expires_at is not None else None
    return {
        "id": item.id,
        "username": item.username,
        "name": item.name,
        "role": "client",
        "company": item.company,
        "phone": item.phone,
        "status": item.status,
        "expiresAt": expires_value,
        "maxSessions": item.max_sessions,
        "failedLoginCount": item.failed_login_count,
        "lockedUntil": iso_datetime(item.locked_until),
        "mustChangePassword": bool(item.must_change_password),
        "createdBy": item.created_by,
        "remark": item.remark,
        "createdAt": iso_datetime(item.created_at),
        "updatedAt": iso_datetime(item.updated_at),
        "lastLoginAt": iso_datetime(item.last_login_at),
    }

def proxy_bypass_hosts(item: Proxy) -> List[str]:
    """Normalize the stored direct-connect list into a plain list of strings.

    Rows written before the column existed hold ``NULL``; legacy rows may also
    hold a non-list value, which is treated as "no exceptions" rather than
    propagated to the desktop client.
    """
    raw = item.bypass_hosts
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, str) and entry]


def proxy_dict(item: Proxy) -> Dict[str, Any]:
    """Serialize proxy metadata without exposing either credential form."""
    return {
        "id": item.id,
        "name": item.name,
        "host": item.host,
        "port": item.port,
        "username": item.username,
        "bypassHosts": proxy_bypass_hosts(item),
        "status": item.status,
        "createdAt": iso_datetime(item.created_at),
        "updatedAt": iso_datetime(item.updated_at),
    }


def desktop_proxy_dict(item: Proxy) -> Dict[str, Any]:
    """Serialize a proxy credential only for the authenticated desktop API."""
    return {
        "id": item.id,
        "name": item.name,
        "host": item.host,
        "port": item.port,
        "username": item.username,
        "password": decrypt_proxy_password(item.encrypted_password),
        "bypassHosts": proxy_bypass_hosts(item),
    }


def safe_image_reference(value: Optional[str], uploaded_file: Optional[UploadedFile]) -> str:
    try:
        normalized = normalize_upload_reference(value or "")
    except ValueError:
        return ""
    if (
        not normalized
        or uploaded_file is None
        or uploaded_file.path != normalized
        or not is_inline_safe(uploaded_file.path, uploaded_file.content_type)
    ):
        return ""
    return normalized

def platform_dict(
    item: Platform,
    *,
    desktop: bool = False,
    uploaded_file: Optional[UploadedFile] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "id": item.id,
        "name": item.name,
        "url": item.url,
        "iconUrl": safe_image_reference(item.icon_url, uploaded_file),
        "sortOrder": item.sort_order,
    }
    if not desktop:
        result.update({
            "status": item.status,
            "createdAt": iso_datetime(item.created_at),
            "updatedAt": iso_datetime(item.updated_at),
        })
    return result


def desktop_lease_from_snapshot(
    user_id: int,
    proxy: Optional[Proxy],
    platforms: List[Platform],
) -> str:
    """Hash the exact ORM snapshot used to serialize a desktop response.

    Password changes are represented by a digest of the Fernet ciphertext;
    plaintext proxy credentials are never decrypted or hashed here.
    """
    payload = {
        "profileKey": f"user-{user_id}",
        "proxy": None
        if proxy is None
        else {
            "id": proxy.id,
            "name": proxy.name,
            "host": proxy.host,
            "port": proxy.port,
            "username": proxy.username,
            "credentialDigest": hashlib.sha256(proxy.encrypted_password).hexdigest(),
            "bypassHosts": proxy_bypass_hosts(proxy),
            "status": proxy.status,
            "updatedAt": proxy.updated_at.isoformat(timespec="microseconds"),
        },
        "platforms": [
            {
                "id": platform.id,
                "name": platform.name,
                "url": platform.url,
                "sortOrder": platform.sort_order,
                "status": platform.status,
                "updatedAt": platform.updated_at.isoformat(timespec="microseconds"),
            }
            for platform in platforms
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

def log_dict(item: UserLog) -> Dict[str, Any]:
    return {
        "id": item.id,
        "requestId": item.request_id,
        "actorType": item.actor_type,
        "actorId": item.actor_id,
        "actorUsername": item.actor_username,
        "actorRole": item.actor_role,
        "action": item.action,
        "targetType": item.target_type,
        "targetId": item.target_id,
        "targetName": item.target_name,
        "summary": item.summary,
        "ipAddress": ip_text(item.ip_address),
        "userAgent": item.user_agent,
        "status": item.status,
        "details": item.details,
        "createdAt": iso_datetime(item.created_at),
    }


def uploaded_file_dict(item: UploadedFile) -> Dict[str, Any]:
    return {
        "id": item.id,
        "name": item.original_name,
        "path": item.path,
        "contentType": item.content_type,
        "size": item.size,
        "uploadedBy": item.uploaded_by,
        "createdAt": iso_datetime(item.created_at),
    }


__all__ = [
    "admin_dict",
    "desktop_lease_from_snapshot",
    "desktop_proxy_dict",
    "log_dict",
    "platform_dict",
    "proxy_bypass_hosts",
    "proxy_dict",
    "safe_image_reference",
    "uploaded_file_dict",
    "user_dict",
]
