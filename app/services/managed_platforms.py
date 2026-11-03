"""Managed platform credentials, verification and one-time browser grants."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Protocol, Tuple
from urllib.parse import urlsplit

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.config import ConfigurationError
from app.core.security import decrypt_platform_value, encrypt_platform_value
from app.db.base import iso_datetime, parse_datetime, utc_now
from app.db.models import ManagedBrowserSession, ManagedPlatformAccount, ManagedPlatformBinding, Platform
from app.db.session import Database
from app.repositories import managed_platforms as managed_repo
from app.repositories import platforms as platforms_repo
from app.repositories import users as users_repo
from app.services.audit import AuditContext, record
from app.services.managed_identity import IdentityProbeOutcome, probe_remote_identity
from app.services.errors import (
    BadRequestError,
    ConflictError,
    ManagedProviderUnavailableError,
    ManagedVerificationRequiredError,
    NotFoundError,
)

MANAGED_ACCOUNT_NOT_FOUND = "托管平台账号不存在"
MANAGED_BINDING_NOT_FOUND = "该用户未绑定托管平台账号"
MANAGED_PLATFORM_NOT_FOUND = "平台不存在"
MANAGED_PLATFORM_INACTIVE = "平台已停用"
MANAGED_USER_NOT_FOUND = "用户不存在"
MANAGED_ACCOUNT_INACTIVE = "托管平台账号已停用或过期"
MANAGED_GRANT_INVALID = "托管登录票据无效、已过期或已消费"
MANAGED_GRANT_REPLAY = "一次性托管登录票据已经消费"
MANAGED_SESSION_INVALID = "托管会话身份无效或尚未消费"
MANAGED_CREDENTIAL_CONFLICT = "托管账号凭据或状态已变更，请刷新后重试"
MANAGED_ACCOUNT_SESSION_EXPIRED = "该托管账号的登录会话已在平台侧退出，请联系管理员替换 Cookie"
BOOTSTRAP_TTL = timedelta(minutes=2)
# 身份探测结果的可信时长；超过后在发放票据时重新探测一次。
IDENTITY_PROBE_TTL = timedelta(hours=24)
# 用户托管账号固定绑定 platform 表中 ID=1 的平台（即方舟）。
MANAGED_ARK_PLATFORM_ID = 1


@contextmanager
def _managed_transaction(database: Database) -> Iterator[Session]:
    """Translate the account mapper's optimistic version check at commit too."""
    try:
        with database.session() as session:
            yield session
    except StaleDataError as exc:
        raise ConflictError(MANAGED_CREDENTIAL_CONFLICT) from exc


def _normalized_device_id(device_id: Optional[str]) -> Optional[str]:
    return (device_id or "").strip() or None


@dataclass(frozen=True)
class ManagedLoginResult:
    status: str
    cookie_bundle: List[Dict[str, Any]]
    detail: str = ""
    remote_account_id: Optional[str] = None
    remote_display_name: Optional[str] = None


class ManagedLoginProvider(Protocol):
    def verify(
        self,
        *,
        platform_url: str,
        auth_mode: str,
        username: Optional[str],
        password: Optional[str],
        cookie_bundle: List[Dict[str, Any]],
    ) -> ManagedLoginResult: ...


def _encrypt_platform_secret(value: str) -> bytes:
    try:
        return encrypt_platform_value(value)
    except ConfigurationError as exc:
        raise ManagedProviderUnavailableError(
            "managed_login_provider_unavailable: 未配置 VESTUS_PLATFORM_SECRET_KEY"
        ) from exc


def _decrypt_platform_secret(value: bytes) -> str:
    try:
        return decrypt_platform_value(value)
    except (ConfigurationError, ValueError) as exc:
        raise ManagedProviderUnavailableError(
            "managed_login_provider_unavailable: 托管平台凭据无法解密"
        ) from exc


def _canonical_cookie(cookie: Mapping[str, Any]) -> Dict[str, Any]:
    """Normalize API/Pydantic/Playwright cookie spellings into one shape."""
    result: Dict[str, Any] = {
        "name": str(cookie.get("name", "")),
        "value": str(cookie.get("value", "")),
        "domain": str(cookie.get("domain", "")).lower(),
        "path": str(cookie.get("path", "/")),
        "secure": bool(cookie.get("secure", True)),
        "httpOnly": bool(cookie.get("httpOnly", cookie.get("http_only", False))),
    }
    same_site = cookie.get("sameSite", cookie.get("same_site"))
    if same_site:
        result["sameSite"] = same_site
    expires_at = cookie.get("expiresAt", cookie.get("expires_at"))
    if expires_at:
        result["expiresAt"] = expires_at
    for key, snake_key in (
        ("partitionKey", "partition_key"),
        ("priority", "priority"),
        ("sourceScheme", "source_scheme"),
    ):
        value = cookie.get(key, cookie.get(snake_key))
        if value is not None:
            result[key] = value
    return result


def _playwright_cookie(cookie: Mapping[str, Any]) -> Dict[str, Any]:
    """Translate the API cookie shape to Playwright's cookie shape."""
    cookie = _canonical_cookie(cookie)
    result: Dict[str, Any] = {
        "name": cookie["name"],
        "value": cookie["value"],
        "domain": cookie["domain"],
        "path": cookie.get("path", "/"),
        "secure": bool(cookie.get("secure", True)),
        "httpOnly": bool(cookie.get("httpOnly", False)),
    }
    if cookie.get("sameSite"):
        result["sameSite"] = cookie["sameSite"]
    if cookie.get("expiresAt"):
        expiry = parse_datetime(cookie["expiresAt"])
        if expiry is not None:
            result["expires"] = expiry.replace(tzinfo=timezone.utc).timestamp()
    for key in ("partitionKey", "priority", "sourceScheme"):
        if cookie.get(key) is not None:
            result[key] = cookie[key]
    return result


def _api_cookie(cookie: Mapping[str, Any]) -> Dict[str, Any]:
    cookie = _canonical_cookie(cookie)
    result: Dict[str, Any] = {
        "name": cookie["name"],
        "value": cookie["value"],
        "domain": cookie["domain"],
        "path": cookie["path"],
        "secure": cookie["secure"],
        "httpOnly": cookie["httpOnly"],
    }
    if cookie.get("sameSite"):
        result["sameSite"] = cookie["sameSite"]
    expires = cookie.get("expires")
    if expires and float(expires) > 0:
        value = datetime.fromtimestamp(float(expires), timezone.utc).replace(tzinfo=None)
        result["expiresAt"] = iso_datetime(value)
    for key in ("partitionKey", "priority", "sourceScheme"):
        if cookie.get(key) is not None:
            result[key] = cookie[key]
    return result


def _cookie_key(cookie: Mapping[str, Any]) -> tuple[str, str, str, str]:
    partition = cookie.get("partitionKey", cookie.get("partition_key"))
    return (
        str(cookie.get("name", "")),
        str(cookie.get("domain", "")).lower().lstrip("."),
        str(cookie.get("path", "/")) or "/",
        json.dumps(partition, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
    )


def _cookie_expiry_error(cookie_bundle: List[Dict[str, Any]]) -> Optional[str]:
    now = utc_now()
    for cookie in cookie_bundle:
        raw = cookie.get("expiresAt", cookie.get("expires_at"))
        if not raw:
            continue
        try:
            expiry = parse_datetime(raw)
        except (TypeError, ValueError):
            return "Cookie 包含无效的过期时间"
        if expiry is not None and expiry <= now:
            return "Cookie 包含已过期条目"
    return None


def _missing_cookie_count(
    expected: List[Dict[str, Any]], observed: List[Dict[str, Any]]
) -> int:
    expected_keys = {_cookie_key(cookie) for cookie in expected}
    observed_keys = {_cookie_key(cookie) for cookie in observed}
    return len(expected_keys - observed_keys)


def _same_site_host(value: str, platform_url: str) -> bool:
    response_host = (urlsplit(value).hostname or "").lower().strip(".")
    target_host = (urlsplit(platform_url).hostname or "").lower().strip(".")
    if not response_host or not target_host:
        return False
    if response_host == target_host or response_host.endswith(f".{target_host}"):
        return True
    target_labels = target_host.split(".")
    if len(target_labels) <= 2:
        return False
    site = ".".join(target_labels[-2:])
    return response_host == site or response_host.endswith(f".{site}")


class PlaywrightManagedLoginProvider:
    """Generic Playwright verifier for a configured managed Chromium binary.

    It deliberately does not contain Ark-specific selectors or anti-bot
    bypasses.  If the upstream page presents a login, captcha, MFA or another
    unknown flow, the result is ``needs_manual_verification`` and no cookie is
    persisted by the service.
    """

    def __init__(self, executable_path: Optional[str] = None, timeout_ms: int = 30_000):
        self.executable_path = executable_path
        self.timeout_ms = timeout_ms

    def _path(self) -> str:
        raw = (self.executable_path or os.getenv("VESTUS_MANAGED_CHROMIUM_PATH") or "").strip()
        if not raw:
            raise ManagedProviderUnavailableError(
                "managed_login_provider_unavailable: 未配置 VESTUS_MANAGED_CHROMIUM_PATH"
            )
        path = Path(raw).expanduser()
        if not path.is_file():
            raise ManagedProviderUnavailableError(
                "managed_login_provider_unavailable: 配置的托管 Chromium 不存在"
            )
        return str(path)

    @staticmethod
    def _page_text(page: Any) -> Optional[str]:
        try:
            return page.locator("body").inner_text(timeout=1000).lower()
        except Exception:
            return None

    @staticmethod
    def _looks_like_login(page: Any) -> bool:
        url = str(getattr(page, "url", "") or "").lower()
        if any(marker in url for marker in ("/login", "passport", "sso/account_login")):
            return True
        text = PlaywrightManagedLoginProvider._page_text(page)
        if text is None or not text.strip():
            # 无法读取页面内容就无法证明已登录，必须 fail-closed。
            return True
        logged_out_markers = (
            "立即登录",
            "扫码登录",
            "请登录",
            "快捷登录",
            "登录/注册",
            "注册/登录",
        )
        captcha_markers = ("验证码", "安全验证", "二次验证", "captcha", "verify code")
        if any(marker in text for marker in logged_out_markers + captcha_markers):
            return True
        # 只有明确出现工作台/退出等登录态证据才允许通过；未知页面一律转人工处理。
        authenticated_markers = (
            "工作台",
            "退出登录",
            "退出账号",
            "workbench",
            "dashboard",
            "workspace",
            "sign out",
            "log out",
        )
        return not any(marker in text for marker in authenticated_markers)

    def verify(
        self,
        *,
        platform_url: str,
        auth_mode: str,
        username: Optional[str],
        password: Optional[str],
        cookie_bundle: List[Dict[str, Any]],
    ) -> ManagedLoginResult:
        if auth_mode == "official_sso":
            raise ManagedProviderUnavailableError(
                "managed_login_provider_unavailable: official_sso 尚未配置授权提供方"
            )
        if auth_mode == "server_login" and (not username or not password):
            raise ManagedVerificationRequiredError(
                "needs_manual_verification: 服务端登录缺少账号或密码"
            )
        if auth_mode == "cookie":
            if not cookie_bundle:
                return ManagedLoginResult("invalid", [], "Cookie 校验失败：没有提供 Cookie")
            expiry_error = _cookie_expiry_error(cookie_bundle)
            if expiry_error:
                return ManagedLoginResult("invalid", [], f"Cookie 校验失败：{expiry_error}")
        executable_path = self._path()
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - dependency is installed in production
            raise ManagedProviderUnavailableError(
                "managed_login_provider_unavailable: Python Playwright 未安装"
            ) from exc

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    headless=True, executable_path=executable_path
                )
                try:
                    context: Any = browser.new_context()
                    if auth_mode == "cookie":
                        context.add_cookies([_playwright_cookie(item) for item in cookie_bundle])
                    page = context.new_page()
                    auth_failures: List[int] = []

                    def observe_response(response: Any) -> None:
                        try:
                            status = int(response.status)
                            response_url = str(response.url)
                        except (AttributeError, TypeError, ValueError):
                            return
                        if status in {401, 403} and _same_site_host(response_url, platform_url):
                            auth_failures.append(status)

                    page.on("response", observe_response)
                    navigation_response = page.goto(
                        platform_url,
                        wait_until="domcontentloaded",
                        timeout=self.timeout_ms,
                    )
                    if auth_mode == "server_login":
                        password_input = page.locator('input[type="password"]').first
                        if password_input.count() == 0:
                            return ManagedLoginResult(
                                "needs_manual_verification", [], "页面没有可识别的密码输入框"
                            )
                        username_input = page.locator(
                            'input[type="email"], input[type="text"]'
                        ).first
                        if username_input.count() == 0:
                            return ManagedLoginResult(
                                "needs_manual_verification", [], "页面没有可识别的账号输入框"
                            )
                        username_input.fill(username or "")
                        password_input.fill(password or "")
                        submit = page.locator('button[type="submit"]').first
                        if submit.count() == 0:
                            submit = page.locator("button").first
                        if submit.count() == 0:
                            return ManagedLoginResult(
                                "needs_manual_verification", [], "页面没有可识别的登录按钮"
                            )
                        submit.click()
                        page.wait_for_timeout(1_000)
                    # domcontentloaded 不代表 SPA 已渲染；立即判定会拿到空文本，
                    # 把未渲染的未登录页误判成已登录。等页面出内容再判。
                    page.wait_for_timeout(2_000)
                    navigation_status = getattr(navigation_response, "status", None)
                    try:
                        navigation_status = int(navigation_status) if navigation_status is not None else None
                    except (TypeError, ValueError):
                        navigation_status = None
                    if navigation_status in {401, 403} or auth_failures:
                        detail = "上游返回未授权/禁止访问"
                        status = "invalid" if auth_mode == "cookie" else "needs_manual_verification"
                        return ManagedLoginResult(status, [], f"Cookie 校验失败：{detail}")
                    if self._looks_like_login(page):
                        status = "invalid" if auth_mode == "cookie" else "needs_manual_verification"
                        return ManagedLoginResult(
                            status,
                            [],
                            "Cookie 校验失败：页面没有可确认的有效登录态"
                            if auth_mode == "cookie"
                            else "需要人工完成登录、验证码或二次验证",
                        )
                    observed_cookies = context.cookies()
                    if auth_mode == "cookie" and _missing_cookie_count(cookie_bundle, observed_cookies):
                        return ManagedLoginResult(
                            "invalid",
                            [],
                            "Cookie 校验失败：有 Cookie 条目已被浏览器或上游清除",
                        )
                    cookies = [_api_cookie(item) for item in observed_cookies]
                    if not cookies:
                        status = "invalid" if auth_mode == "cookie" else "needs_manual_verification"
                        return ManagedLoginResult(
                            status, [], "验证后没有获得有效会话 Cookie"
                        )
                    return ManagedLoginResult("verified", cookies)
                finally:
                    browser.close()
        except ManagedVerificationRequiredError:
            raise
        except ManagedProviderUnavailableError:
            raise
        except Exception as exc:
            detail = str(exc).lower()
            if "executable" in detail or "browser" in detail or "launch" in detail:
                raise ManagedProviderUnavailableError(
                    "managed_login_provider_unavailable: 托管 Chromium 启动失败"
                ) from exc
            raise ManagedVerificationRequiredError(
                "needs_manual_verification: 方舟登录验证失败，请由管理员人工处理"
            ) from exc


_provider_factory: Callable[[], ManagedLoginProvider] = PlaywrightManagedLoginProvider


def get_managed_login_provider() -> ManagedLoginProvider:
    return _provider_factory()


def _json_cookie_bundle(value: List[Dict[str, Any]]) -> str:
    return json.dumps(
        [_canonical_cookie(item) for item in value],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _parse_cookie_bundle(value: Optional[bytes]) -> List[Dict[str, Any]]:
    if not value:
        return []
    try:
        parsed = json.loads(decrypt_platform_value(value))
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ManagedProviderUnavailableError(
            "managed_login_provider_unavailable: 托管平台 Cookie 无法解密，请联系管理员重新保存"
        ) from exc
    return [_canonical_cookie(item) for item in parsed if isinstance(item, dict)]


def _plain_cookie_bundle(value: Any) -> List[Dict[str, Any]]:
    if not value:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ManagedProviderUnavailableError(
                "managed_login_provider_unavailable: 托管平台 Cookie 格式无效"
            ) from exc
    if not isinstance(value, list):
        return []
    return [_canonical_cookie(item) for item in value if isinstance(item, dict)]


def _account_dict(item: ManagedPlatformAccount) -> Dict[str, Any]:
    return {
        "id": item.id,
        "platformId": item.platform_id,
        "name": item.name,
        "authMode": item.auth_mode,
        "allowedHosts": list(item.allowed_hosts or []),
        "credentialVersion": item.credential_version,
        "expiresAt": iso_datetime(item.expires_at),
        "status": item.status,
        "sessionStatus": item.session_status,
        "lastError": item.last_error,
        "lastVerifiedAt": iso_datetime(item.last_verified_at),
        "remoteAccountId": item.remote_account_id,
        "remoteDisplayName": item.remote_display_name,
        "identityCheckedAt": iso_datetime(item.identity_checked_at),
        "createdBy": item.created_by,
        "createdAt": iso_datetime(item.created_at),
        "updatedAt": iso_datetime(item.updated_at),
    }


def _account_display_name(item: ManagedPlatformAccount) -> str:
    return (
        (item.remote_display_name or "").strip()
        or (item.name or "").strip()
        or f"账号-{item.id}"
    )


def _binding_dict(
    binding: ManagedPlatformBinding,
    account: ManagedPlatformAccount,
    *,
    platform_name: Optional[str] = None,
) -> Dict[str, Any]:
    status = binding.status
    if account.status != "active":
        status = account.status
    elif account.expires_at is not None and account.expires_at <= utc_now():
        status = "expired"
    return {
        "id": binding.id,
        "userId": binding.user_id,
        "platformId": binding.platform_id,
        "platformName": platform_name,
        "managedAccountId": account.id,
        "name": _account_display_name(account),
        "accountName": _account_display_name(account),
        "alias": account.name,
        "authMode": account.auth_mode,
        "status": status,
        "sessionStatus": account.session_status,
        "expiresAt": iso_datetime(account.expires_at),
        "credentialVersion": account.credential_version,
        "remoteAccountId": account.remote_account_id,
        "remoteDisplayName": account.remote_display_name,
        "identityCheckedAt": iso_datetime(account.identity_checked_at),
        "lastVerifiedAt": iso_datetime(account.last_verified_at),
    }


def _account_detail_dict(
    item: ManagedPlatformAccount, *, platform_name: Optional[str] = None
) -> Dict[str, Any]:
    username, password, cookies = _credential_values(item)
    return {
        **_account_dict(item),
        "platformName": platform_name or "方舟",
        "username": username,
        "password": password,
        "cookieBundle": cookies,
    }


def _credential_values(item: ManagedPlatformAccount) -> tuple[Optional[str], Optional[str], List[Dict[str, Any]]]:
    if item.username is not None or item.password is not None or item.cookie_bundle is not None:
        return item.username, item.password, _plain_cookie_bundle(item.cookie_bundle)
    username = _decrypt_platform_secret(item.encrypted_username) if item.encrypted_username else None
    password = _decrypt_platform_secret(item.encrypted_password) if item.encrypted_password else None
    return username, password, _parse_cookie_bundle(item.encrypted_cookie_bundle)


def _require_platform(session: Any, platform_id: int) -> Platform:
    platform = platforms_repo.get(session, platform_id)
    if platform is None:
        raise NotFoundError(MANAGED_PLATFORM_NOT_FOUND)
    return platform


def _require_ark_platform(session: Any) -> Platform:
    platform = session.get(Platform, MANAGED_ARK_PLATFORM_ID)
    if platform is None:
        raise BadRequestError("请先在「平台管理」中创建方舟平台入口（ID=1）并填写方舟地址")
    if platform.status != "active":
        raise BadRequestError("方舟平台入口（ID=1）已停用，请先在「平台管理」中启用")
    return platform


def _platform_allowed_hosts(platform: Platform) -> List[str]:
    """Derive the desktop allowlist from the platform entry URL.

    The per-user dialog no longer collects ``allowedHosts``，so the server
    derives a registrable-domain allowlist：it covers the entry host, its
    sibling subdomains, and the cookie domains the upstream login sets
    （e.g. ``https://agent.oceanengine.com/`` → ``oceanengine.com``）.
    """
    hostname = (urlsplit(str(platform.url)).hostname or "").lower().strip(".")
    if not hostname:
        return []
    labels = hostname.split(".")
    if len(labels) > 2 and not labels[-1].isdigit():
        hostname = ".".join(labels[-2:])
    return [hostname]


def _identity_probe(
    platform_url: str, cookie_bundle: List[Dict[str, Any]]
) -> Optional[IdentityProbeOutcome]:
    """Module-level indirection so tests can stub the upstream HTTP call."""
    return probe_remote_identity(platform_url, cookie_bundle)


def _probe_cookie_credentials(
    platform: Platform, cookie_bundle: List[Dict[str, Any]]
) -> Optional[IdentityProbeOutcome]:
    """Probe freshly submitted cookie credentials before they are persisted.

    A definitively dead session (upstream ``code != 0``) rejects the write so
    a broken cookie can never enter the account pool.  Platforms without a
    probe and network failures return instead of raising: saving credentials
    must not depend on the probe being reachable.
    """
    outcome = _identity_probe(platform.url, cookie_bundle)
    if outcome is not None and outcome.state == "invalid":
        raise BadRequestError(f"Cookie 校验失败：{outcome.detail or '上游登录态已失效'}")
    return outcome


def _apply_identity_outcome(
    item: ManagedPlatformAccount, outcome: Optional[IdentityProbeOutcome]
) -> None:
    """Fill the remote identity fields from a successful probe."""
    if outcome is None or outcome.state != "verified":
        return
    now = utc_now()
    item.remote_account_id = outcome.remote_account_id
    item.remote_display_name = outcome.remote_display_name
    item.identity_checked_at = now
    item.last_verified_at = now


# 桌面同步前的会话探测缓存：(account_id, credential_version) -> (monotonic, 状态)。
# 只缓存确定结论（verified/invalued 归并为 valid/expired）；凭据版本变更自然作废旧键，
# 有效结论 5 分钟内不重复请求上游，失效结论在管理员更新 Cookie 前不再探测。
SESSION_PROBE_VALID_TTL = timedelta(minutes=5)
_session_probe_cache: Dict[Tuple[int, int], Tuple[float, str]] = {}
_session_probe_cache_lock = threading.Lock()


def _session_probe_cache_get(account_id: int, credential_version: int) -> Optional[str]:
    with _session_probe_cache_lock:
        entry = _session_probe_cache.get((account_id, int(credential_version)))
    if entry is None:
        return None
    probed_at, status = entry
    if (
        status == "valid"
        and time.monotonic() - probed_at >= SESSION_PROBE_VALID_TTL.total_seconds()
    ):
        return None
    return status


def _session_probe_cache_store(account_id: int, credential_version: int, status: str) -> None:
    if status not in ("valid", "expired"):
        return
    with _session_probe_cache_lock:
        _session_probe_cache[(account_id, int(credential_version))] = (time.monotonic(), status)


def refresh_session_statuses(database: Database, user_id: int | str) -> None:
    """桌面端拉取配置前单向收紧会话状态：valid -> expired，永不自动恢复。

    失效只能由管理员保存新凭据（那时重新探测）或客户端上报触发；探测不可达、
    平台变更响应结构等情况一律保持现状，绝不据此把有效会话标成失效。
    每个确定结论按 (账号, 凭据版本) 缓存，避免每次同步都请求上游。
    """
    with database.session() as session:
        if users_repo.get_active(session, user_id) is None:
            return
        now = utc_now()
        rows = (
            session.query(ManagedPlatformAccount, Platform)
            .join(
                ManagedPlatformBinding,
                ManagedPlatformBinding.managed_account_id == ManagedPlatformAccount.id,
            )
            .join(Platform, Platform.id == ManagedPlatformAccount.platform_id)
            .filter(
                ManagedPlatformBinding.user_id == int(user_id),
                ManagedPlatformBinding.status == "active",
                ManagedPlatformAccount.status == "active",
                ManagedPlatformAccount.session_status == "valid",
                ManagedPlatformAccount.auth_mode == "cookie",
                ManagedPlatformAccount.cookie_bundle.isnot(None),
                ManagedPlatformBinding.platform_id == Platform.id,
                Platform.status == "active",
            )
            .all()
        )
    pending: List[Tuple[int, int, int, str, Optional[List[Dict[str, Any]]]]] = []
    for account, platform in rows:
        if account.expires_at is not None and account.expires_at <= now:
            continue
        version = int(account.credential_version)
        cached = _session_probe_cache_get(account.id, version)
        if cached == "expired":
            pending.append((account.id, platform.id, version, platform.url, None))
            continue
        if cached == "valid":
            continue
        pending.append((account.id, platform.id, version, platform.url, list(account.cookie_bundle or [])))
    for account_id, platform_id, version, platform_url, cookies in pending:
        if cookies is None:
            status = "expired"  # 缓存中的确定失效结论。
        else:
            outcome = _identity_probe(platform_url, cookies)
            if outcome is None or outcome.state == "unavailable":
                continue  # 未知：保持现状，本次不缓存。
            status = "valid" if outcome.state == "verified" else "expired"
        _session_probe_cache_store(account_id, version, status)
        if status != "expired":
            continue
        with _managed_transaction(database) as session:
            managed_repo.expire_account_session(
                session,
                account_id=account_id,
                platform_id=platform_id,
                user_id=int(user_id),
                credential_version=version,
                now=utc_now(),
                last_error="自动校验：上游会话已失效",
            )


def list_accounts(database: Database) -> List[Dict[str, Any]]:
    with database.session() as session:
        return [_account_dict(item) for item in managed_repo.list_accounts(session)]


def get_account(database: Database, account_id: int | str) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        item = managed_repo.get_account(session, account_id)
        return _account_dict(item) if item else None


def create_account(
    database: Database, values: Dict[str, Any], *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    auth_mode = values.get("auth_mode", "cookie")
    username = values.get("username")
    password = values.get("password")
    cookies = values.get("cookie_bundle")
    if auth_mode == "server_login" and (not username or not password):
        raise BadRequestError("server_login 必须提供账号和密码")
    if auth_mode == "cookie" and not cookies:
        raise BadRequestError("cookie 模式必须提供 Cookie 包")
    with database.session() as session:
        platform = _require_platform(session, int(values["platform_id"]))
        identity_outcome = (
            _probe_cookie_credentials(platform, cookies) if auth_mode == "cookie" else None
        )
        try:
            item = ManagedPlatformAccount(
                platform_id=platform.id,
                name=str(values["name"]).strip(),
                auth_mode=auth_mode,
                username=username if auth_mode == "server_login" else None,
                password=password if auth_mode == "server_login" else None,
                cookie_bundle=cookies if auth_mode == "cookie" else None,
                allowed_hosts=list(values.get("allowed_hosts") or []),
                credential_version=1,
                expires_at=parse_datetime(values.get("expires_at"), end_of_day=True),
                status=values.get("status", "active"),
                created_by=values.get("created_by"),
            )
            _apply_identity_outcome(item, identity_outcome)
            session.add(item)
            session.flush()
        except IntegrityError as exc:
            raise ConflictError("同一平台下的托管账号别名已存在") from exc
        result = _account_dict(item)
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_CREATED",
            f"创建托管平台账号 {item.name}",
            target_type="managed_platform_account",
            target_id=item.id,
            target_name=item.name,
            details={"platformId": platform.id, "authMode": item.auth_mode},
        )
        return result


def update_account(
    database: Database,
    account_id: int | str,
    values: Dict[str, Any],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with _managed_transaction(database) as session:
        item = managed_repo.get_account_for_update(session, account_id)
        if item is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        credential_changed = False
        if "name" in values:
            item.name = str(values["name"]).strip()
        if "auth_mode" in values:
            item.auth_mode = values["auth_mode"]
            # Changing the source of credentials invalidates any cached
            # session from the previous mode; never reuse it silently.
            item.cookie_bundle = None
            item.encrypted_cookie_bundle = None
            credential_changed = True
        if values.get("username") is not None:
            item.username = values["username"]
            item.encrypted_username = None
            item.encrypted_cookie_bundle = None
            item.cookie_bundle = None
            credential_changed = True
        if values.get("password") is not None:
            item.password = values["password"]
            item.encrypted_password = None
            item.encrypted_cookie_bundle = None
            item.cookie_bundle = None
            credential_changed = True
        if values.get("cookie_bundle") is not None:
            item.cookie_bundle = list(values["cookie_bundle"])
            item.encrypted_cookie_bundle = None
            item.username = None
            item.password = None
            credential_changed = True
        if "allowed_hosts" in values and values["allowed_hosts"] is not None:
            item.allowed_hosts = list(values["allowed_hosts"])
        if "expires_at" in values:
            item.expires_at = parse_datetime(values.get("expires_at"), end_of_day=True)
        if "status" in values and values["status"] is not None:
            item.status = values["status"]
        # Keep only the credential type used by the final authentication mode.
        # This avoids retaining an old password or Cookie after an administrator
        # switches the account source.
        if item.auth_mode == "cookie":
            item.username = None
            item.password = None
            item.encrypted_username = None
            item.encrypted_password = None
        elif item.auth_mode == "official_sso":
            item.username = None
            item.password = None
            item.cookie_bundle = None
            item.encrypted_username = None
            item.encrypted_password = None
            item.encrypted_cookie_bundle = None
        if item.auth_mode == "server_login" and (
            (item.username is None and item.encrypted_username is None)
            or (item.password is None and item.encrypted_password is None)
        ):
            raise BadRequestError("server_login 必须提供账号和密码")
        if item.auth_mode == "cookie" and item.cookie_bundle is None and item.encrypted_cookie_bundle is None:
            raise BadRequestError("cookie 模式必须提供 Cookie 包")
        if credential_changed:
            item.credential_version = int(item.credential_version) + 1
            item.last_verified_at = None
            item.last_error = None
            item.remote_account_id = None
            item.remote_display_name = None
            item.identity_checked_at = None
            # 新凭据就是新会话：清除客户端上报的失效标记。
            item.session_status = "valid"
        if credential_changed and item.auth_mode == "cookie":
            platform = platforms_repo.get(session, item.platform_id)
            if platform is not None:
                _apply_identity_outcome(
                    item, _probe_cookie_credentials(platform, _credential_values(item)[2])
                )
        try:
            session.flush()
        except IntegrityError as exc:
            raise ConflictError("同一平台下的托管账号别名已存在") from exc
        result = _account_dict(item)
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_UPDATED",
            f"更新托管平台账号 {item.name}",
            target_type="managed_platform_account",
            target_id=item.id,
            target_name=item.name,
            details={"fields": [key for key in values if key not in {"password", "cookie_bundle"}]},
        )
        return result


def delete_account(
    database: Database, account_id: int | str, *, audit: Optional[AuditContext] = None
) -> None:
    with _managed_transaction(database) as session:
        item = managed_repo.get_account_for_update(session, account_id)
        if item is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        item.status = "revoked"
        item.credential_version = int(item.credential_version) + 1
        item.encrypted_cookie_bundle = None
        item.cookie_bundle = None
        item.encrypted_password = None
        item.encrypted_username = None
        item.password = None
        item.username = None
        item.last_error = "管理员已撤销"
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_REVOKED",
            f"撤销托管平台账号 {item.name}",
            target_type="managed_platform_account",
            target_id=item.id,
            target_name=item.name,
        )


def check_account_identity(
    database: Database, account_id: int | str, *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    """Probe the stored cookie against the platform's user-info endpoint.

    ``verified`` refreshes the remote identity and restores a client-reported
    expired session (the cookie demonstrably still works); ``invalid`` marks
    the session expired for the admins; a probe/network failure surfaces as
    503 without touching stored state.
    """
    with _managed_transaction(database) as session:
        item = managed_repo.get_account_for_update(session, account_id)
        if item is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        if item.auth_mode != "cookie":
            raise BadRequestError("仅 Cookie 模式的托管账号支持在线校验登录态")
        platform = platforms_repo.get(session, item.platform_id)
        if platform is None:
            raise NotFoundError(MANAGED_PLATFORM_NOT_FOUND)
        outcome = _identity_probe(platform.url, _credential_values(item)[2])
        if outcome is None:
            raise BadRequestError("该平台暂不支持在线校验登录态（Cookie 需包含 sessionid）")
        now = utc_now()
        if outcome.state == "verified":
            item.remote_account_id = outcome.remote_account_id
            item.remote_display_name = outcome.remote_display_name
            item.identity_checked_at = now
            item.last_verified_at = now
            item.session_status = "valid"
            item.last_error = None
        elif outcome.state == "invalid":
            item.session_status = "expired"
            item.last_error = outcome.detail or "上游登录态已失效"
        else:
            raise ManagedProviderUnavailableError(
                f"managed_identity_probe_unavailable: {outcome.detail or '登录态校验请求失败'}"
            )
        result = {"state": outcome.state, "detail": outcome.detail, "account": _account_dict(item)}
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_IDENTITY_CHECKED",
            f"校验托管账号 {item.name} 的平台登录态",
            target_type="managed_platform_account",
            target_id=item.id,
            target_name=item.name,
            details={"state": outcome.state, "platformId": item.platform_id},
        )
        return result


def bind_account(
    database: Database,
    account_id: int | str,
    user_id: int | str,
    *,
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with database.session() as session:
        account = managed_repo.get_account(session, account_id)
        if account is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        user = users_repo.get_active(session, user_id)
        if user is None or (
            visible_admin_id is not None and user.bound_admin_id != int(visible_admin_id)
        ):
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        platform = session.get(Platform, account.platform_id)
        platform_name = platform.name if platform is not None else None
        existing = managed_repo.get_binding_for_account(
            session, user.id, account.platform_id, account.id
        )
        if existing is not None:
            existing.status = "active"
            existing.updated_at = utc_now()
            result = _binding_dict(existing, account, platform_name=platform_name)
        else:
            item = ManagedPlatformBinding(
                user_id=user.id,
                platform_id=account.platform_id,
                managed_account_id=account.id,
                status="active",
            )
            session.add(item)
            try:
                session.flush()
            except IntegrityError as exc:
                raise ConflictError("该用户已绑定此平台的托管账号") from exc
            result = _binding_dict(item, account, platform_name=platform_name)
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_BOUND",
            f"绑定托管平台账号 {account.name} 到用户 {user.username}",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"userId": user.id, "platformId": account.platform_id},
        )
        return result


def unbind_account(
    database: Database,
    account_id: int | str,
    user_id: int | str,
    *,
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> None:
    """Remove a managed-platform binding within the caller's user scope."""

    with database.session() as session:
        account = managed_repo.get_account(session, account_id)
        if account is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        user = users_repo.get_active(session, user_id)
        if user is None or (
            visible_admin_id is not None and user.bound_admin_id != int(visible_admin_id)
        ):
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        binding = managed_repo.get_binding_for_account(
            session, user.id, account.platform_id, account.id
        )
        if binding is None:
            raise NotFoundError(MANAGED_BINDING_NOT_FOUND)
        session.delete(binding)
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_UNBOUND",
            f"解除托管平台账号 {account.name} 与用户 {user.username} 的绑定",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"userId": user.id, "platformId": account.platform_id},
        )


def get_user_account(database: Database, user_id: int | str) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        user = users_repo.get_active(session, user_id)
        if user is None:
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        platform = session.get(Platform, MANAGED_ARK_PLATFORM_ID)
        if platform is None:
            return None
        bindings = managed_repo.list_bindings(session, user.id, platform.id)
        if not bindings:
            return None
        if len(bindings) > 1:
            raise ConflictError("该用户已绑定多个托管账号，请使用托管账号列表接口")
        account = managed_repo.get_account(session, bindings[0].managed_account_id)
        if account is None:
            return None
        return _account_detail_dict(account, platform_name=platform.name)


def list_user_accounts(
    database: Database, user_id: int | str
) -> List[Dict[str, Any]]:
    with database.session() as session:
        user = users_repo.get_active(session, user_id)
        if user is None:
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        bindings = managed_repo.list_bindings_for_user(session, user.id)
        result: List[Dict[str, Any]] = []
        for binding in bindings:
            account = managed_repo.get_account(session, binding.managed_account_id)
            if account is None:
                continue
            platform = session.get(Platform, binding.platform_id)
            result.append(
                _binding_dict(
                    binding,
                    account,
                    platform_name=platform.name if platform is not None else None,
                )
            )
        return result


def get_user_bound_account(
    database: Database, user_id: int | str, managed_account_id: int | str
) -> Dict[str, Any]:
    with database.session() as session:
        user = users_repo.get_active(session, user_id)
        if user is None:
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        account = managed_repo.get_account(session, managed_account_id)
        if account is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        binding = managed_repo.get_binding_for_account(
            session, user.id, account.platform_id, account.id
        )
        if binding is None:
            raise NotFoundError(MANAGED_BINDING_NOT_FOUND)
        platform = session.get(Platform, account.platform_id)
        return _account_detail_dict(
            account, platform_name=platform.name if platform is not None else None
        )


def _next_user_account_name(session: Any, platform_id: int, user_id: int) -> str:
    existing_names = {
        item.name
        for item in managed_repo.list_accounts(session)
        if item.platform_id == platform_id
    }
    base = f"user-{user_id}-ark"
    if base not in existing_names:
        return base
    index = 2
    while f"{base}-{index}" in existing_names:
        index += 1
    return f"{base}-{index}"


def create_user_bound_account(
    database: Database,
    user_id: int | str,
    values: Dict[str, Any],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    auth_mode = values.get("auth_mode")
    username = values.get("username")
    password = values.get("password")
    cookies = values.get("cookie_bundle")
    if auth_mode == "server_login" and (not username or not password):
        raise BadRequestError("server_login 必须提供账号和密码")
    if auth_mode == "cookie" and not cookies:
        raise BadRequestError("cookie 模式必须提供 Cookie 包")
    if auth_mode not in {"cookie", "server_login"}:
        raise BadRequestError("authMode must be cookie or server_login")

    with database.session() as session:
        user = users_repo.get_active(session, user_id)
        if user is None:
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        platform = _require_ark_platform(session)
        raw_name = (values.get("name") or "").strip()
        name = raw_name or _next_user_account_name(session, platform.id, user.id)
        identity_outcome = (
            _probe_cookie_credentials(platform, list(cookies or []))
            if auth_mode == "cookie"
            else None
        )
        try:
            account = ManagedPlatformAccount(
                platform_id=platform.id,
                name=name,
                auth_mode=auth_mode,
                username=username if auth_mode == "server_login" else None,
                password=password if auth_mode == "server_login" else None,
                cookie_bundle=list(cookies or []) if auth_mode == "cookie" else None,
                allowed_hosts=_platform_allowed_hosts(platform),
                credential_version=1,
                expires_at=None,
                status="active",
                created_by=audit.actor_id if audit else None,
            )
            _apply_identity_outcome(account, identity_outcome)
            session.add(account)
            session.flush()
        except IntegrityError as exc:
            raise ConflictError("同一平台下的托管账号别名已存在") from exc

        binding = ManagedPlatformBinding(
            user_id=user.id,
            platform_id=platform.id,
            managed_account_id=account.id,
            status="active",
        )
        session.add(binding)
        session.flush()
        result = _binding_dict(binding, account, platform_name=platform.name)
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_USER_CREATED",
            f"为用户 {user.username} 新增并绑定托管账号 {account.name}",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"userId": user.id, "platformId": platform.id, "authMode": auth_mode},
        )
        return result


def update_user_bound_account(
    database: Database,
    user_id: int | str,
    managed_account_id: int | str,
    values: Dict[str, Any],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with _managed_transaction(database) as session:
        user = users_repo.get_active(session, user_id)
        if user is None:
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        account = managed_repo.get_account(session, managed_account_id)
        if account is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        binding = managed_repo.get_binding_for_account_for_update(
            session, user.id, account.platform_id, account.id
        )
        if binding is None:
            raise NotFoundError(MANAGED_BINDING_NOT_FOUND)
        account = managed_repo.get_account_for_update(session, managed_account_id)
        if account is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        platform = _require_platform(session, account.platform_id)

        credential_changed = False
        if values.get("name") is not None:
            account.name = str(values["name"]).strip()
        if values.get("auth_mode") is not None and values["auth_mode"] != account.auth_mode:
            account.auth_mode = values["auth_mode"]
            account.cookie_bundle = None
            account.encrypted_cookie_bundle = None
            credential_changed = True
        if values.get("username") is not None:
            account.username = values["username"]
            account.encrypted_username = None
            account.cookie_bundle = None
            account.encrypted_cookie_bundle = None
            credential_changed = True
        if values.get("password") is not None:
            account.password = values["password"]
            account.encrypted_password = None
            account.cookie_bundle = None
            account.encrypted_cookie_bundle = None
            credential_changed = True
        if values.get("cookie_bundle") is not None:
            account.cookie_bundle = list(values["cookie_bundle"])
            account.encrypted_cookie_bundle = None
            account.username = None
            account.password = None
            account.encrypted_username = None
            account.encrypted_password = None
            credential_changed = True

        if account.auth_mode == "cookie":
            account.username = None
            account.password = None
            account.encrypted_username = None
            account.encrypted_password = None
            if account.cookie_bundle is None and account.encrypted_cookie_bundle is None:
                raise BadRequestError("cookie 模式必须提供 Cookie 包")
        elif account.auth_mode == "server_login":
            if (
                (account.username is None and account.encrypted_username is None)
                or (account.password is None and account.encrypted_password is None)
            ):
                raise BadRequestError("server_login 必须提供账号和密码")

        account.allowed_hosts = _platform_allowed_hosts(platform)
        account.status = "active"
        binding.status = "active"
        binding.updated_at = utc_now()
        if credential_changed:
            account.credential_version = int(account.credential_version) + 1
            account.last_verified_at = None
            account.last_error = None
            account.remote_account_id = None
            account.remote_display_name = None
            account.identity_checked_at = None
            # 新凭据就是新会话：清除客户端上报的失效标记。
            account.session_status = "valid"
        if credential_changed and account.auth_mode == "cookie":
            _apply_identity_outcome(
                account, _probe_cookie_credentials(platform, _credential_values(account)[2])
            )

        try:
            session.flush()
        except IntegrityError as exc:
            raise ConflictError("同一平台下的托管账号别名已存在") from exc

        result = _account_detail_dict(account, platform_name=platform.name)
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_USER_UPDATED",
            f"更新用户 {user.username} 的托管账号 {account.name}",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"userId": user.id, "platformId": platform.id, "authMode": account.auth_mode},
        )
        return result


def upsert_user_account(
    database: Database,
    user_id: int | str,
    values: Dict[str, Any],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    auth_mode = values.get("auth_mode")
    username = values.get("username")
    password = values.get("password")
    cookies = values.get("cookie_bundle")
    if auth_mode == "server_login" and (not username or not password):
        raise BadRequestError("server_login 必须提供账号和密码")
    if auth_mode == "cookie" and not cookies:
        raise BadRequestError("cookie 模式必须提供 Cookie 包")
    if auth_mode not in {"cookie", "server_login"}:
        raise BadRequestError("authMode must be cookie or server_login")

    with _managed_transaction(database) as session:
        user = users_repo.get_active(session, user_id)
        if user is None:
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        platform = _require_ark_platform(session)
        bindings = managed_repo.list_bindings(session, user.id, platform.id)
        if len(bindings) > 1:
            raise ConflictError("该用户已绑定多个托管账号，请使用按账号接口保存")
        pair = None
        if bindings:
            binding = managed_repo.get_binding_for_account_for_update(
                session, user.id, platform.id, bindings[0].managed_account_id
            )
            if binding is None:
                raise ConflictError(MANAGED_CREDENTIAL_CONFLICT)
            account = managed_repo.get_account_for_update(session, binding.managed_account_id)
            if account is not None:
                pair = (binding, account)
        if pair is None:
            identity_outcome = (
                _probe_cookie_credentials(platform, list(cookies or []))
                if auth_mode == "cookie"
                else None
            )
            account = ManagedPlatformAccount(
                platform_id=platform.id,
                name=f"user-{user.id}-ark",
                auth_mode=auth_mode,
                username=username if auth_mode == "server_login" else None,
                password=password if auth_mode == "server_login" else None,
                cookie_bundle=list(cookies or []) if auth_mode == "cookie" else None,
                allowed_hosts=_platform_allowed_hosts(platform),
                credential_version=1,
                expires_at=None,
                status="active",
                created_by=audit.actor_id if audit else None,
            )
            _apply_identity_outcome(account, identity_outcome)
            session.add(account)
            session.flush()
            binding = ManagedPlatformBinding(
                user_id=user.id,
                platform_id=platform.id,
                managed_account_id=account.id,
                status="active",
            )
            session.add(binding)
            session.flush()
        else:
            binding, account = pair
            account.auth_mode = auth_mode
            account.username = username if auth_mode == "server_login" else None
            account.password = password if auth_mode == "server_login" else None
            account.cookie_bundle = list(cookies or []) if auth_mode == "cookie" else None
            account.encrypted_username = None
            account.encrypted_password = None
            account.encrypted_cookie_bundle = None
            account.allowed_hosts = _platform_allowed_hosts(platform)
            account.expires_at = None
            account.status = "active"
            account.session_status = "valid"
            account.credential_version = int(account.credential_version) + 1
            account.last_verified_at = None
            account.last_error = None
            account.remote_account_id = None
            account.remote_display_name = None
            account.identity_checked_at = None
            binding.status = "active"
            binding.updated_at = utc_now()
            if auth_mode == "cookie":
                _apply_identity_outcome(
                    account, _probe_cookie_credentials(platform, list(cookies or []))
                )
            session.flush()
        result = _account_detail_dict(account, platform_name=platform.name)
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_USER_UPSERTED",
            f"为用户 {user.username} 配置方舟托管账号",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"userId": user.id, "platformId": platform.id, "authMode": auth_mode},
        )
        return result


def delete_user_account(
    database: Database,
    user_id: int | str,
    *,
    audit: Optional[AuditContext] = None,
) -> None:
    with _managed_transaction(database) as session:
        user = users_repo.get_active(session, user_id)
        if user is None:
            raise NotFoundError(MANAGED_USER_NOT_FOUND)
        platform = session.get(Platform, MANAGED_ARK_PLATFORM_ID)
        if platform is None:
            raise NotFoundError(MANAGED_BINDING_NOT_FOUND)
        bindings = managed_repo.list_bindings(session, user.id, platform.id)
        if len(bindings) > 1:
            raise ConflictError("该用户已绑定多个托管账号，请使用托管账号列表接口删除指定账号")
        pair = None
        if bindings:
            binding = managed_repo.get_binding_for_account_for_update(
                session, user.id, platform.id, bindings[0].managed_account_id
            )
            if binding is not None:
                account = managed_repo.get_account_for_update(session, binding.managed_account_id)
                if account is not None:
                    pair = (binding, account)
        if pair is None:
            raise NotFoundError(MANAGED_BINDING_NOT_FOUND)
        binding, account = pair
        session.delete(binding)
        account.status = "revoked"
        account.credential_version = int(account.credential_version) + 1
        account.username = None
        account.password = None
        account.cookie_bundle = None
        account.encrypted_username = None
        account.encrypted_password = None
        account.encrypted_cookie_bundle = None
        account.last_error = "管理员已撤销"
        record(
            session,
            audit,
            "MANAGED_ACCOUNT_USER_DELETED",
            f"解除用户 {user.username} 的方舟托管账号",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"userId": user.id, "platformId": platform.id},
        )


def _mark_cookie_session_invalid(
    database: Database,
    account_id: int,
    expected_state: tuple[int, str, str, Any],
    detail: str,
) -> None:
    with _managed_transaction(database) as session:
        item = managed_repo.get_account_for_update(session, account_id)
        if item is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        current_state = (item.credential_version, item.status, item.session_status, item.expires_at)
        if current_state != expected_state:
            raise ConflictError(MANAGED_CREDENTIAL_CONFLICT)
        if item.session_status != "expired":
            item.session_status = "expired"
            item.credential_version = int(item.credential_version) + 1
        item.last_error = detail



def _load_bootstrap_context(
    database: Database,
    user_id: int,
    platform_id: int,
    managed_account_id: Optional[int] = None,
) -> tuple[ManagedPlatformBinding, ManagedPlatformAccount, Platform]:
    with database.session() as session:
        if managed_account_id is None:
            bindings = managed_repo.list_bindings(session, user_id, platform_id)
            if len(bindings) > 1:
                raise ConflictError("该平台绑定了多个托管账号，请选择具体账号")
            binding = bindings[0] if bindings else None
        else:
            binding = managed_repo.get_binding_for_account(
                session, user_id, platform_id, managed_account_id
            )
        if binding is None:
            raise NotFoundError(MANAGED_BINDING_NOT_FOUND)
        if binding.status != "active":
            raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
        account = managed_repo.get_account(session, binding.managed_account_id)
        if account is None or account.platform_id != platform_id:
            raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
        if account.status != "active" or (account.expires_at is not None and account.expires_at <= utc_now()):
            raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
        if account.session_status == "expired":
            raise ConflictError(MANAGED_ACCOUNT_SESSION_EXPIRED)
        platform = _require_platform(session, platform_id)
        if platform.status != "active":
            raise ConflictError(MANAGED_PLATFORM_INACTIVE)
        return binding, account, platform


def issue_bootstrap(
    database: Database,
    user_id: int | str,
    platform_id: int | str,
    device_id: Optional[str],
    *,
    managed_account_id: Optional[int | str] = None,
    provider: Optional[ManagedLoginProvider] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    _binding, account, platform = _load_bootstrap_context(
        database,
        int(user_id),
        int(platform_id),
        int(managed_account_id) if managed_account_id is not None else None,
    )
    username, password, cookies = _credential_values(account)
    # Reuse a verified bundle while issuing short-lived bootstrap grants. A
    # desktop retry must not re-run the provider and bump credential_version,
    # otherwise every click would create another local profile for the same
    # managed account. Administrators explicitly verify/rotate credentials
    # when the upstream session needs refreshing.
    if not cookies:
        provider = provider or get_managed_login_provider()
        result = provider.verify(
            platform_url=platform.url,
            auth_mode=account.auth_mode,
            username=username,
            password=password,
            cookie_bundle=cookies,
        )
        if result.status != "verified":
            raise ManagedVerificationRequiredError(
                f"needs_manual_verification: {result.detail or '需要人工验证'}"
            )
        cookies = result.cookie_bundle
        # Playwright 已确认页面登录态，这里只为补齐远端身份：探测结果仅在
        # verified 时采用，其余情况以浏览器验证为准。
        identity_outcome = _identity_probe(platform.url, cookies)
        with _managed_transaction(database) as session:
            binding = managed_repo.get_binding_for_account_for_update(
                session, user_id, platform_id, account.id
            )
            if binding is None or binding.status != "active":
                raise ConflictError(MANAGED_GRANT_INVALID)
            fresh = managed_repo.get_account_for_update(session, account.id)
            if fresh is None:
                raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
            if fresh.credential_version != account.credential_version:
                raise ConflictError(MANAGED_CREDENTIAL_CONFLICT)
            if fresh.session_status != "valid":
                raise ConflictError(MANAGED_ACCOUNT_SESSION_EXPIRED)
            if fresh.status != "active" or (fresh.expires_at is not None and fresh.expires_at <= utc_now()):
                raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
            fresh.cookie_bundle = list(cookies)
            fresh.encrypted_cookie_bundle = None
            fresh.credential_version = int(fresh.credential_version) + 1
            fresh.last_verified_at = utc_now()
            fresh.last_error = None
            fresh.session_status = "valid"
            fresh.remote_account_id = result.remote_account_id
            fresh.remote_display_name = result.remote_display_name
            fresh.identity_checked_at = (
                utc_now()
                if result.remote_account_id or result.remote_display_name
                else None
            )
            _apply_identity_outcome(fresh, identity_outcome)
            account_version = fresh.credential_version
    else:
        account_version = account.credential_version
        reuse_identity_outcome: Optional[IdentityProbeOutcome] = None
        if account.auth_mode == "cookie":
            # 复用已存 Cookie 时兜底探测：身份未知或结果超期才发起。
            # 明确失效则标记会话过期并拒发票据；探测本身失败不影响发放。
            identity_fresh = (
                account.identity_checked_at is not None
                and (utc_now() - account.identity_checked_at) <= IDENTITY_PROBE_TTL
            )
            if not identity_fresh:
                reuse_identity_outcome = _identity_probe(platform.url, cookies)
                if (
                    reuse_identity_outcome is not None
                    and reuse_identity_outcome.state == "invalid"
                ):
                    with _managed_transaction(database) as session:
                        fresh = managed_repo.get_account_for_update(session, account.id)
                        if (
                            fresh is not None
                            and fresh.credential_version == account.credential_version
                        ):
                            fresh.session_status = "expired"
                            fresh.last_error = reuse_identity_outcome.detail
                    raise ConflictError(MANAGED_ACCOUNT_SESSION_EXPIRED)
    raw_token = secrets.token_urlsafe(32)
    now = utc_now()
    with database.session() as session:
        binding = managed_repo.get_binding_for_account_for_update(
            session, user_id, platform_id, account.id
        )
        if binding is None or binding.status != "active":
            raise ConflictError(MANAGED_GRANT_INVALID)
        fresh = managed_repo.get_account_for_update(session, account.id)
        if fresh is None or fresh.platform_id != int(platform_id):
            raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
        if fresh.session_status != "valid":
            raise ConflictError(MANAGED_ACCOUNT_SESSION_EXPIRED)
        if fresh.status != "active" or (fresh.expires_at is not None and fresh.expires_at <= now):
            raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
        if fresh.credential_version != account_version:
            raise ConflictError(MANAGED_CREDENTIAL_CONFLICT)
        if reuse_identity_outcome is not None:
            _apply_identity_outcome(fresh, reuse_identity_outcome)
        platform = _require_platform(session, int(platform_id))
        if platform.status != "active":
            raise ConflictError(MANAGED_PLATFORM_INACTIVE)
        allowed_hosts = list(fresh.allowed_hosts or []) or _platform_allowed_hosts(platform)
        row = ManagedBrowserSession(
            grant_hash=hashlib.sha256(raw_token.encode("utf-8")).hexdigest(),
            user_id=int(user_id),
            platform_id=int(platform_id),
            managed_account_id=account.id,
            credential_version=account_version,
            device_id=_normalized_device_id(device_id),
            expires_at=now + BOOTSTRAP_TTL,
        )
        session.add(row)
        session.flush()
        record(
            session,
            audit,
            "MANAGED_SESSION_BOOTSTRAP_ISSUED",
            "签发一次性托管登录票据",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"platformId": int(platform_id), "deviceId": device_id},
        )
        return {
            "bootstrapToken": raw_token,
            "managedAccountId": account.id,
            "credentialVersion": account_version,
            "allowedHosts": allowed_hosts,
            "expiresAt": iso_datetime(row.expires_at),
        }


def consume_bootstrap(
    database: Database,
    user_id: int | str,
    platform_id: int | str,
    raw_token: str,
    device_id: Optional[str],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    digest = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    with database.session() as session:
        row = managed_repo.get_session_for_update(session, digest)
        now = utc_now()
        if row is None or row.user_id != int(user_id) or row.platform_id != int(platform_id):
            raise ConflictError(MANAGED_GRANT_INVALID)
        if row.consumed_at is not None:
            raise ConflictError(MANAGED_GRANT_REPLAY)
        if row.expires_at <= now or _normalized_device_id(row.device_id) != _normalized_device_id(device_id):
            raise ConflictError(MANAGED_GRANT_INVALID)
        # A grant is only valid while the user is still actively bound to the
        # same managed account.  Without this check, an administrator could
        # unbind or switch a user after issuance and the old bearer-like
        # bootstrap token would remain redeemable until its short TTL elapsed.
        # Lock the binding row while consuming the grant. This serializes a
        # concurrent administrator unbind/switch with the final credential
        # check: either the revoke wins and the grant is rejected, or the
        # already-started consume completes before the revoke commits.
        binding = managed_repo.get_binding_for_account_for_update(
            session,
            row.user_id,
            row.platform_id,
            row.managed_account_id,
        )
        if (
            binding is None
            or binding.status != "active"
        ):
            raise ConflictError(MANAGED_GRANT_INVALID)
        account = managed_repo.get_account_for_update(session, row.managed_account_id)
        if (
            account is None
            or account.platform_id != row.platform_id
            or account.status != "active"
            or account.session_status != "valid"
            or (account.expires_at is not None and account.expires_at <= now)
            or account.credential_version != row.credential_version
        ):
            raise ConflictError(MANAGED_GRANT_INVALID)
        platform = _require_platform(session, row.platform_id)
        if platform.status != "active":
            raise ConflictError(MANAGED_PLATFORM_INACTIVE)
        _username, _password, cookies = _credential_values(account)
        if not cookies:
            raise ConflictError(MANAGED_GRANT_INVALID)
        if not managed_repo.consume_session(session, row, utc_now()):
            raise ConflictError(MANAGED_GRANT_INVALID)
        result = {
            "sessionId": str(row.id),
            "managedAccountId": row.managed_account_id,
            "credentialVersion": row.credential_version,
            "targetUrl": platform.url,
            "cookieBundle": cookies,
            "allowedHosts": list(account.allowed_hosts or []) or _platform_allowed_hosts(platform),
            "expiresAt": iso_datetime(row.expires_at),
        }
        record(
            session,
            audit,
            "MANAGED_SESSION_BOOTSTRAP_CONSUMED",
            "消费一次性托管登录票据",
            target_type="managed_platform_account",
            target_id=account.id,
            target_name=account.name,
            details={"platformId": int(platform_id), "deviceId": device_id},
        )
        return result


def report_session_expired(
    database: Database,
    user_id: int | str,
    platform_id: int | str,
    managed_account_id: int | str,
    credential_version: int,
    session_id: str,
    device_id: Optional[str] = None,
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    """Expire only the exact credential used by this user's consumed session.

    Grant expires_at is a redemption deadline, not a running-session deadline.
    Authenticate the full report even when it is stale; only then may retries
    return the current account state without changing it or recording an audit.
    """
    with database.session() as session:
        # Keep the same grant -> binding -> account lock order as consume.
        row = managed_repo.get_session_by_id_for_update(session, session_id)
        if (
            row is None
            or row.user_id != int(user_id)
            or row.platform_id != int(platform_id)
            or row.managed_account_id != int(managed_account_id)
            or row.credential_version != credential_version
            or row.consumed_at is None
            or _normalized_device_id(row.device_id) != _normalized_device_id(device_id)
        ):
            raise ConflictError(MANAGED_SESSION_INVALID)
        binding = managed_repo.get_binding_for_account_for_update(
            session, row.user_id, row.platform_id, row.managed_account_id
        )
        if binding is None:
            raise NotFoundError(MANAGED_BINDING_NOT_FOUND)
        if binding.status != "active":
            raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
        account = managed_repo.get_account_for_update(session, row.managed_account_id)
        if account is None or account.platform_id != int(platform_id):
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        platform = _require_platform(session, row.platform_id)
        if platform.status != "active":
            raise ConflictError(MANAGED_PLATFORM_INACTIVE)
        now = utc_now()
        if account.status != "active" or (account.expires_at is not None and account.expires_at <= now):
            raise ConflictError(MANAGED_ACCOUNT_INACTIVE)
        applied = managed_repo.expire_account_session(
            session,
            account_id=account.id,
            platform_id=row.platform_id,
            user_id=row.user_id,
            credential_version=credential_version,
            now=now,
            last_error="客户端上报：用户在平台退出登录",
        )
        # An explicit locking refresh avoids a stale identity-map/repeatable-read
        # snapshot if the conditional write lost to another report or rotation.
        account = managed_repo.get_account_for_update(session, row.managed_account_id)
        if account is None:
            raise NotFoundError(MANAGED_ACCOUNT_NOT_FOUND)
        if applied:
            record(
                session,
                audit,
                "MANAGED_SESSION_EXPIRED",
                "客户端上报托管账号在平台侧退出登录",
                target_type="managed_platform_account",
                target_id=account.id,
                target_name=account.name,
                details={
                    "platformId": row.platform_id,
                    "userId": row.user_id,
                    "sessionId": str(row.id),
                    "credentialVersion": credential_version,
                    "deviceId": _normalized_device_id(device_id),
                },
            )
        return {
            "sessionStatus": account.session_status,
            "credentialVersion": account.credential_version,
            "applied": applied,
        }


def list_all_bindings(
    database: Database,
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    """管理端「绑定托管」总览：全部用户的绑定 + 会话状态与失效计数。"""
    del audit  # 只读列表，不记审计。
    with database.session() as session:
        bindings = managed_repo.list_all_bindings(session)
        accounts = {
            item.id: item
            for item in managed_repo.list_accounts(session)
        }
        users = {
            item.id: item for item in users_repo.list_all(session)
        }
        platforms: Dict[int, str] = {}
        items: List[Dict[str, Any]] = []
        expired_count = 0
        for binding in bindings:
            account = accounts.get(binding.managed_account_id)
            if account is None:
                continue
            platform_name = platforms.get(binding.platform_id)
            if platform_name is None:
                platform = platforms_repo.get(session, binding.platform_id)
                platform_name = platform.name if platform else f"平台-{binding.platform_id}"
                platforms[binding.platform_id] = platform_name
            user = users.get(binding.user_id)
            session_status = account.session_status
            if session_status == "expired":
                expired_count += 1
            items.append(
                {
                    "bindingId": binding.id,
                    "userId": binding.user_id,
                    "username": user.username if user else f"用户-{binding.user_id}",
                    "userName": user.name if user else None,
                    "userStatus": user.status if user else None,
                    "platformId": binding.platform_id,
                    "platformName": platform_name,
                    "managedAccountId": account.id,
                    "name": _account_display_name(account),
                    "authMode": account.auth_mode,
                    "status": binding.status,
                    "accountStatus": account.status,
                    "sessionStatus": session_status,
                    "lastError": account.last_error,
                    "credentialVersion": account.credential_version,
                    "expiresAt": iso_datetime(account.expires_at),
                    "lastVerifiedAt": iso_datetime(account.last_verified_at),
                    "remoteDisplayName": account.remote_display_name,
                }
            )
        return {"items": items, "total": len(items), "expiredCount": expired_count}


__all__ = [
    "ManagedLoginProvider",
    "ManagedLoginResult",
    "PlaywrightManagedLoginProvider",
    "bind_account",
    "consume_bootstrap",
    "create_account",
    "create_user_bound_account",
    "delete_account",
    "delete_user_account",
    "get_account",
    "get_user_account",
    "get_user_bound_account",
    "get_managed_login_provider",
    "issue_bootstrap",
    "list_accounts",
    "list_all_bindings",
    "refresh_session_statuses",
    "report_session_expired",
    "unbind_account",
    "update_account",
    "update_user_bound_account",
    "upsert_user_account",
]
