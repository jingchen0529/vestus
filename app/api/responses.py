"""Response shaping: collection payloads, and absolute URLs for stored uploads.

Managed uploads are stored as ``/uploads/<name>`` so the database never records
a hostname.  The desktop client and the admin console both need a fetchable URL,
so the path is expanded against the request's own base URL -- which keeps working
behind a reverse proxy, and behind a different one tomorrow.
"""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import Request


def collection(items: List[Any]) -> Dict[str, Any]:
    """The shape every unpaginated list endpoint answers with.

    Collections used to come back as bare JSON arrays, which left no room to add
    a count or a cursor without breaking the callers.  Naming the array makes
    every list response extensible and identical to the paginated one, whose
    ``total`` comes from the query instead of ``len()``.
    """

    return {"items": items, "total": len(items)}


def absolute_upload_reference(request: Request, relative_path: str) -> str:
    if not relative_path:
        return ""
    return f"{str(request.base_url).rstrip('/')}{relative_path}"


def externalize_platform_icons(request: Request, result: Dict[str, Any]) -> None:
    """Rewrite every platform icon in a desktop payload, in place."""

    for platform in result.get("platforms", []):
        platform["iconUrl"] = absolute_upload_reference(request, platform.get("iconUrl", ""))


def uploaded_file_response(request: Request, item: Dict[str, Any]) -> Dict[str, Any]:
    return {**item, "url": absolute_upload_reference(request, item["path"])}


__all__ = [
    "absolute_upload_reference",
    "collection",
    "externalize_platform_icons",
    "uploaded_file_response",
]
