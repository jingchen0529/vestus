"""Explicit Ark email/password login; no captcha or device-verification bypasses."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlsplit

ARK_ORIGIN = "https://agent.oceanengine.com"
ARK_IDENTITY_URL = f"{ARK_ORIGIN}/agent/user/user-info/"
ARK_LOGIN_URL = (
    f"{ARK_ORIGIN}/login?redirect_uri={quote(f'{ARK_ORIGIN}/admin/homepage', safe='')}"
)


@dataclass(frozen=True)
class ArkLoginResult:
    status: str
    cookie_bundle: list[dict[str, Any]] = field(default_factory=list)
    detail: str = ""
    remote_account_id: str | None = None
    remote_display_name: str | None = None


def supports_ark_login(platform_url: str) -> bool:
    try:
        url = urlsplit(platform_url)
        return (
            url.scheme == "https" and url.hostname == "agent.oceanengine.com"
            and url.port in (None, 443) and url.username is None and url.password is None
        )
    except ValueError:
        return False


def _failure(page: Any) -> ArkLoginResult:
    try:
        # Only inspect the login area, not dashboard copy such as verification
        # expiry warnings for the user's customers.
        text = page.locator("#login-container").inner_text(timeout=1000)
    except Exception:
        text = ""
    invalid_markers = (
        "密码错误",
        "密码不正确",
        "账号或密码",
        "帐号或密码",
        "账号已锁定",
        "账户已锁定",
        "账号不存在",
    )
    if any(word in text for word in invalid_markers):
        return ArkLoginResult("invalid_credentials", detail="账号或密码错误，或账号受限")
    if any(word in text for word in ("验证码", "安全验证", "短信验证", "扫码验证", "二次验证")):
        return ArkLoginResult("needs_manual_verification", detail="平台要求人工验证")
    return ArkLoginResult("unavailable", detail="登录未能在限定时间内完成")


def login_ark(
    page: Any, context: Any, username: str, password: str, timeout_ms: int = 30_000
) -> ArkLoginResult:
    """The caller owns a fresh context and closes it on every outcome."""
    if not supports_ark_login(str(page.url)):
        return ArkLoginResult("unsupported", detail="自动登录只允许方舟官方 HTTPS 入口")
    if not username or not password:
        return ArkLoginResult("invalid_credentials", detail="缺少邮箱或密码")
    deadline = time.monotonic() + timeout_ms / 1000

    def remaining() -> int:
        return max(1, int((deadline - time.monotonic()) * 1000))

    try:
        # 平台入口可能配的是营销首页（没有登录表单）；自动登录固定走官方登录页，
        # 登录后跳回管理后台首页，保证拿到完整的管理端会话 Cookie。
        if not str(page.url).split("://", 1)[-1].split("/", 1)[-1].startswith("login"):
            page.goto(ARK_LOGIN_URL, wait_until="domcontentloaded", timeout=remaining())
        form = page.locator("#login-container")
        form.wait_for(state="visible", timeout=remaining())
        if not supports_ark_login(str(page.url)):
            return ArkLoginResult("unsupported", detail="登录页离开了方舟官方入口")
        form.get_by_text("邮箱登录", exact=True).click(timeout=remaining())
        form.locator('input[name="email"]').fill(username, timeout=remaining())
        form.locator('input[name="password"]').fill(password, timeout=remaining())
        agreement = form.locator(".account-center-agreement-check")
        # The upstream SDK uses a DIV, not an input[type=checkbox]. Check its
        # actual state before clicking so a saved selection is never toggled off.
        checked = agreement.evaluate("""el => {
            const c = getComputedStyle(el).backgroundColor;
            return el.getAttribute('aria-checked') === 'true'
                || el.classList.contains('checked') || el.classList.contains('active')
                || (c !== 'rgb(255, 255, 255)' && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent');
        }""", timeout=remaining())
        if not checked:
            agreement.click(timeout=remaining())
        submit = form.get_by_role("button", name="登录", exact=True)
        # 平台前端校验不通过时按钮保持 disabled，并把原因写在 title 里
        # （例如「密码应为6-20位字符」）。等待 enabled 永远不会成功，先读出
        # 校验文案直接给管理员一个可行动的结论。
        if not submit.is_enabled(timeout=2_000):
            reason = str(submit.get_attribute("title") or "").strip()
            return ArkLoginResult(
                "invalid_credentials",
                detail=f"平台登录校验未通过：{reason or '账号或密码格式不符合要求'}",
            )
        # Native Playwright click waits for the disabled button to become enabled.
        submit.click(timeout=remaining())
        page.wait_for_function(
            """() => {
                const form = document.querySelector('#login-container');
                if (!form || !form.getClientRects().length) return true;
                const message = form.querySelector('.account-center-message')?.textContent?.trim();
                const challenge = form.innerText || '';
                return Boolean(message) || /安全验证|短信验证|扫码验证|二次验证|验证码/.test(challenge);
            }""",
            timeout=remaining(),
        )
        if not supports_ark_login(str(page.url)):
            return ArkLoginResult("needs_manual_verification", detail="登录跳转需要人工确认")
        if page.locator("#login-container").is_visible():
            return _failure(page)
        response = context.request.get(ARK_IDENTITY_URL, timeout=remaining(), max_redirects=0)
        if response.status != 200:
            return ArkLoginResult("unavailable", detail="登录身份校验失败")
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        if payload.get("code") != 0 or not isinstance(data, dict) or not data.get("userId"):
            return ArkLoginResult("unavailable", detail="未取得有效登录身份")
        email = str(data.get("email") or "").strip().casefold()
        if not email or email != username.strip().casefold():
            return ArkLoginResult("identity_mismatch", detail="登录身份与填写的邮箱不一致")
        cookies = [cookie for cookie in context.cookies() if (
            str(cookie.get("domain", "")).lstrip(".") == "oceanengine.com"
            or str(cookie.get("domain", "")).lstrip(".").endswith(".oceanengine.com")
        )]
        if not any(cookie.get("name") in {"sessionid", "sessionid_ss"} and cookie.get("value") for cookie in cookies):
            return ArkLoginResult("unavailable", detail="未取得登录会话 Cookie")
        display = " · ".join(filter(None, (
            str(data.get("userName") or data.get("employeeName") or "").strip(),
            str(data.get("companyName") or "").strip(),
        )))
        return ArkLoginResult("verified", cookies, remote_account_id=str(data["userId"]), remote_display_name=display)
    except Exception:
        # Raw Playwright errors can include filled values. Return fixed messages.
        return _failure(page)
