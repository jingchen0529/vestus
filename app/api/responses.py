"""Turning stored upload paths into absolute URLs.

Managed uploads are stored as ``/uploads/<name>`` so the database never records
a hostname.  The desktop client and the admin console both need a fetchable URL,
so the path is expanded against the request's own base URL -- which keeps working
behind a reverse proxy, and behind a different one tomorrow.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import Request


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
    "externalize_platform_icons",
    "uploaded_file_response",
]
