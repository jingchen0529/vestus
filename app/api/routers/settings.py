"""Branding settings for the desktop client and the admin console."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.deps import admin_auth, audit_context, get_db
from app.api.envelope import EnvelopeRoute
from app.db.session import Database
from app.schemas.settings import MAX_REPO_LENGTH, REPO_PATTERN, SettingsUpdate
from app.services import settings as settings_service

MAX_TITLE_LENGTH = 100

router = APIRouter(route_class=EnvelopeRoute)


def _validated_title(value: str | None, detail: str) -> str | None:
    """Trim a display name, refusing oversized or non-printable text."""

    if value is None:
        return None
    text = (value or "").strip()
    if text and (len(text) > MAX_TITLE_LENGTH or any(not c.isprintable() for c in text)):
        raise HTTPException(status_code=400, detail=detail)
    return text


def _classify_asset_platform(filename: str) -> str:
    name_lower = filename.lower()
    if "macos" in name_lower or "darwin" in name_lower or ".dmg" in name_lower:
        if "aarch64" in name_lower or "arm64" in name_lower or "m1" in name_lower or "apple" in name_lower:
            return "macOS (Apple Silicon M系列)"
        return "macOS (Intel x86_64)"
    if "windows" in name_lower or ".exe" in name_lower or ".msi" in name_lower:
        return "Windows (x86_64)"
    if "appimage" in name_lower:
        return "Linux (AppImage)"
    if ".deb" in name_lower:
        return "Linux (Debian / Ubuntu)"
    return "通用安装包"


def _release_version(tag_name: str) -> str:
    """Strip the release-tag decoration, leaving the bare version number.

    Prefix-anchored on purpose: a blanket ``replace("v", "")`` also eats the
    ``v`` inside a tag such as ``v1.0-preview``.
    """
    version = tag_name.strip()
    for prefix in ("desktop-", "v"):
        if version.startswith(prefix):
            version = version[len(prefix) :]
    return version


@router.get("/api/admin/settings", tags=["system"])
def get_admin_settings(
    auth: Dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db)
) -> Dict[str, Any]:
    return settings_service.get_branding(db)


@router.put("/api/admin/settings", tags=["system"])
@router.post("/api/admin/settings", tags=["system"])
def update_admin_settings(
    payload: SettingsUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    name = _validated_title(payload.product_name, "桌面端产品名称格式无效")
    admin_title = _validated_title(payload.admin_title, "管理端系统名称格式无效")
    return settings_service.set_branding(
        db,
        product_name=name,
        logo_url=payload.logo_url,
        admin_title=admin_title,
        admin_logo_url=payload.admin_logo_url,
        admin_theme_color=payload.admin_theme_color,
        desktop_version=payload.desktop_version,
        github_repo=payload.github_repo,
        audit=audit_context(request, auth),
    )


@router.get("/api/admin/settings/github-release", tags=["system"])
def get_github_latest_release(
    repo: Optional[str] = Query(default=None),
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    """Fetch the latest release information and installable assets from GitHub."""
    branding = settings_service.get_branding(db)
    target_repo = (repo or branding.get("githubRepo") or settings_service.DEFAULT_GITHUB_REPO).strip()

    if len(target_repo) > MAX_REPO_LENGTH or ".." in target_repo or not REPO_PATTERN.match(target_repo):
        raise HTTPException(status_code=400, detail="GitHub 仓库名称格式无效，应为 owner/repo 格式")

    headers = {
        "User-Agent": "Vestus-Admin-Console",
        "Accept": "application/vnd.github.v3+json",
    }

    url = f"https://api.github.com/repos/{target_repo}/releases/latest"
    req = urllib.request.Request(url, headers=headers)
    data: Dict[str, Any] = {}

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status == 200:
                data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # Fallback to list releases if latest is a draft or tagged pre-release
            try:
                list_url = f"https://api.github.com/repos/{target_repo}/releases"
                list_req = urllib.request.Request(list_url, headers=headers)
                with urllib.request.urlopen(list_req, timeout=10) as list_resp:
                    releases = json.loads(list_resp.read().decode("utf-8"))
                    if not releases:
                        raise HTTPException(status_code=404, detail="未在 GitHub 找到此仓库的任何发布版本")
                    data = releases[0]
            except HTTPException:
                # Already carries the precise reason; a broad re-wrap below would
                # replace it with the vaguer message.
                raise
            except Exception as fallback_err:
                raise HTTPException(status_code=404, detail="未在 GitHub 找到此仓库的 Release 版本") from fallback_err
        elif exc.code == 403:
            raise HTTPException(status_code=429, detail="GitHub API 访问频次受限，请稍后重试") from exc
        else:
            raise HTTPException(status_code=502, detail=f"获取 GitHub 版本信息失败: {exc.reason}") from exc
    except Exception as exc:
        raise HTTPException(status_code=504, detail=f"连接 GitHub 失败或网络超时: {str(exc)}") from exc

    tag_name = data.get("tag_name", "")
    clean_version = _release_version(tag_name)
    assets = [
        {
            "name": asset.get("name", ""),
            "downloadUrl": asset.get("browser_download_url", ""),
            "size": asset.get("size", 0),
            "platform": _classify_asset_platform(asset.get("name", "")),
        }
        for asset in data.get("assets", [])
    ]

    return {
        "repo": target_repo,
        "tagName": tag_name,
        "version": clean_version,
        "name": data.get("name") or tag_name,
        "publishedAt": data.get("published_at", ""),
        "htmlUrl": data.get("html_url", ""),
        "body": data.get("body", ""),
        "assets": assets,
    }


__all__ = ["router"]
