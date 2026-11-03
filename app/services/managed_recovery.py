"""Durable background recovery of password-managed upstream sessions."""

from __future__ import annotations

import logging
import secrets
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import timedelta
from typing import Any

from app.db.base import iso_datetime, utc_now
from app.db.models import ManagedPlatformAccount, Platform
from app.db.session import Database
from app.repositories import managed_recovery as recovery_repo
from app.services.errors import ManagedProviderUnavailableError, ManagedVerificationRequiredError

logger = logging.getLogger(__name__)
RECOVERY_MAX_ATTEMPTS = 3
RECOVERY_LEASE = timedelta(seconds=120)
RECOVERY_RETRY_SECONDS = (5, 15)
RECOVERY_COOLDOWN = timedelta(seconds=15)
RECOVERY_ACTIVE_STATES = {"pending", "running", "retry_wait"}


def recovery_fields(account: ManagedPlatformAccount) -> dict[str, Any]:
    return {
        "autoRelogin": bool(account.auto_relogin and account.auth_mode == "server_login"),
        "recoveryStatus": account.recovery_status or "idle",
        "recoveryAttempts": account.recovery_attempts or 0,
        "nextRecoveryAt": iso_datetime(account.next_recovery_at),
        "lastRecoveredAt": iso_datetime(account.last_recovered_at),
    }


def cancel_recovery(account: ManagedPlatformAccount) -> None:
    account.recovery_status = "idle"
    account.recovery_attempts = 0
    account.next_recovery_at = None
    account.recovery_lease_token = None
    account.recovery_lease_until = None


def queue_recovery(account: ManagedPlatformAccount, *, reset: bool = False) -> bool:
    """Queue in the caller's transaction, never spawn a browser before commit."""
    if not account.auto_relogin or account.auth_mode != "server_login" or account.status != "active":
        return False
    now = utc_now()
    if account.expires_at is not None and account.expires_at <= now:
        return False
    if not reset and account.recovery_status in RECOVERY_ACTIVE_STATES | {"failed"}:
        return False
    cancel_recovery(account)
    account.session_status = "expired"
    account.recovery_status = "pending"
    account.next_recovery_at = now
    # A newly restored session that is immediately rejected must not cause a
    # tight login loop across all desktops bound to this account.
    if not reset and account.last_recovered_at is not None:
        account.next_recovery_at = max(now, account.last_recovered_at + RECOVERY_COOLDOWN)
    return True


def run_recovery(database: Database, account_id: int, *, provider: Any = None) -> bool:
    """Claim once across API workers; do browser I/O outside all DB transactions."""
    from app.services import managed_platforms as managed_service

    token = secrets.token_hex(24)
    now = utc_now()
    with database.session() as session:
        account = recovery_repo.claim(
            session, account_id, now, now + RECOVERY_LEASE, token, RECOVERY_MAX_ATTEMPTS
        )
        if account is None:
            return False
        platform = session.get(Platform, account.platform_id)
        if platform is None:
            return False
        platform_url = platform.url
    try:
        username, password, _cookies = managed_service._credential_values(account)
        result = (provider or managed_service.get_managed_login_provider()).verify(
            platform_url=platform_url, auth_mode="server_login", username=username,
            password=password, cookie_bundle=[],
        )
        state = result.status
        cookies = [managed_service._api_cookie(cookie) for cookie in result.cookie_bundle]
        remote_id = result.remote_account_id
        remote_name = result.remote_display_name
        if state == "verified" and (not cookies or not remote_id):
            state = "unavailable"
        if (
            state == "verified" and account.remote_account_id is not None
            and str(remote_id) != str(account.remote_account_id)
        ):
            state = "identity_mismatch"
    except ManagedProviderUnavailableError:
        state, cookies, remote_id, remote_name = "unavailable", [], None, None
    except ManagedVerificationRequiredError:
        state, cookies, remote_id, remote_name = "needs_manual_verification", [], None, None
    except Exception:
        # Browser exceptions can contain URLs and filled credentials. Never log
        # the exception or forward its raw message to the administrator.
        logger.warning("managed recovery provider failed for account %s", account_id)
        state, cookies, remote_id, remote_name = "unavailable", [], None, None

    now = utc_now()
    if state == "verified":
        values = {
            "cookie_bundle": cookies, "encrypted_cookie_bundle": None,
            "credential_version": int(account.credential_version) + 1,
            "session_status": "valid", "recovery_status": "idle", "recovery_attempts": 0,
            "next_recovery_at": None, "last_recovered_at": now, "last_verified_at": now,
            "identity_checked_at": now, "remote_account_id": remote_id,
            "remote_display_name": remote_name, "last_error": None,
        }
    else:
        terminal = state in {"invalid_credentials", "needs_manual_verification", "identity_mismatch", "unsupported"}
        retry = not terminal and account.recovery_attempts < RECOVERY_MAX_ATTEMPTS
        messages = {
            "invalid_credentials": "自动登录失败：账号或密码错误、账号受限，请更新凭据",
            "needs_manual_verification": "平台要求人工验证，自动登录已停止，请处理后重新保存凭据",
            "identity_mismatch": "自动登录返回的账号身份不一致，已拒绝替换 Cookie",
            "unsupported": "该平台未配置自动登录适配，目前仅支持巨量引擎方舟",
        }
        default_detail = (
            "自动登录暂时失败，系统将重试"
            if retry
            else "自动登录连续失败，请检查网络和浏览器配置"
        )
        detail = messages.get(state, default_detail)
        next_recovery_at = (
            now + timedelta(seconds=RECOVERY_RETRY_SECONDS[account.recovery_attempts - 1])
            if retry
            else None
        )
        values = {
            "session_status": "expired",
            "recovery_status": "retry_wait" if retry else "failed",
            "next_recovery_at": next_recovery_at,
            "last_error": detail,
        }
    with database.session() as session:
        current_platform = session.get(Platform, account.platform_id)
        if current_platform is None or current_platform.url != platform_url:
            return False
        applied = recovery_repo.finish(session, account_id, account.credential_version, token, now, values)
    if applied:
        logger.info("managed recovery account=%s state=%s", account_id, values["recovery_status"])
    return applied and state == "verified"


class ManagedRecoveryWorker:
    """Small bounded pool; job state and exclusive leases live in the database."""

    def __init__(self, database: Database, *, interval: float = 1.0, concurrency: int = 2) -> None:
        self.database = database
        self.interval = interval
        self.concurrency = concurrency
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._pool: ThreadPoolExecutor | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._pool = ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix="managed-login")
        self._thread = threading.Thread(target=self._run, name="managed-recovery", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        if self._pool is not None:
            self._pool.shutdown(wait=True, cancel_futures=True)

    def _run(self) -> None:
        jobs: dict[int, Future[bool]] = {}
        while not self._stop.is_set():
            for account_id, job in list(jobs.items()):
                if job.done():
                    try:
                        job.result()
                    except Exception:
                        logger.warning("managed recovery job interrupted for account %s", account_id)
                    del jobs[account_id]
            if len(jobs) < self.concurrency:
                try:
                    with self.database.session() as session:
                        account_ids = recovery_repo.due_accounts(session, utc_now(), self.concurrency)
                    for account_id in account_ids:
                        if account_id not in jobs and len(jobs) < self.concurrency and self._pool is not None:
                            jobs[account_id] = self._pool.submit(run_recovery, self.database, account_id)
                except Exception:
                    logger.warning("managed recovery queue unavailable; retrying later")
            self._stop.wait(self.interval)
