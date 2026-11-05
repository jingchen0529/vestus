"""Service-layer tests for ``app.services.managed_platforms``.

The upstream identity probe is stubbed at the module seam
(``managed_service._identity_probe``) so the session state machine runs without
network.  Everything else stays real: platforms, users, accounts and bindings
are created through their service functions, so these tests pin the refresh /
expiry / recovery behaviour exactly as production exercises it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, List, Optional

import pytest

from app.db.models import ManagedPlatformAccount, UserLog
from app.db.session import Database
from app.services import managed_platforms as managed_service
from app.services import platforms as platforms_service
from app.services import users as users_service
from app.services.audit import AuditContext
from app.services.errors import BadRequestError, ConflictError, ManagedProviderUnavailableError
from app.services.managed_identity import IdentityProbeOutcome

_COOKIE = {"name": "sid", "value": "tok-1", "domain": ".oceanengine.com", "path": "/"}


class ProbeStub:
    """Deterministic stand-in for the module-level upstream probe."""

    def __init__(self) -> None:
        self.outcome: Optional[IdentityProbeOutcome] = None
        self.calls = 0

    def __call__(
        self, platform_url: str, cookies: List[Dict[str, Any]]
    ) -> Optional[IdentityProbeOutcome]:
        self.calls += 1
        return self.outcome


@pytest.fixture()
def probe(monkeypatch: pytest.MonkeyPatch) -> ProbeStub:
    managed_service._session_probe_cache.clear()
    stub = ProbeStub()
    monkeypatch.setattr(managed_service, "_identity_probe", stub)
    yield stub
    managed_service._session_probe_cache.clear()


def _platform(service_db: Database) -> Dict[str, Any]:
    return platforms_service.create_platform(
        service_db, {"name": "巨量引擎", "url": "https://ad.oceanengine.com"}
    )


def _bound_account(
    service_db: Database, *, auth_mode: str = "cookie"
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """A platform, an account on it, and a user with an active binding."""
    platform = _platform(service_db)
    values: Dict[str, Any] = {
        "platform_id": platform["id"],
        "name": "投放一号",
        "auth_mode": auth_mode,
    }
    if auth_mode == "cookie":
        values["cookie_bundle"] = [dict(_COOKIE)]
    else:
        values.update({"username": "ad-ops", "password": "pw-123456"})
    account = managed_service.create_account(service_db, values)
    user = users_service.create_user(
        service_db, {"username": "op1", "name": "运营一号", "password": "password-1"}
    )
    managed_service.bind_account(service_db, account["id"], user["id"])
    return account, user


def _account(service_db: Database, account_id: int) -> ManagedPlatformAccount:
    with service_db.session() as session:
        return session.get(ManagedPlatformAccount, account_id)


def test_create_account_requires_credentials_per_mode(
    service_db: Database, probe: ProbeStub
) -> None:
    platform = _platform(service_db)

    with pytest.raises(BadRequestError) as exc:
        managed_service.create_account(
            service_db,
            {"platform_id": platform["id"], "name": "半成品", "auth_mode": "server_login"},
        )
    assert "server_login" in exc.value.detail

    with pytest.raises(BadRequestError) as exc:
        managed_service.create_account(
            service_db,
            {"platform_id": platform["id"], "name": "半成品", "auth_mode": "cookie"},
        )
    assert "Cookie 包" in exc.value.detail


def test_dead_cookie_is_rejected_before_persist(service_db: Database, probe: ProbeStub) -> None:
    platform = _platform(service_db)
    probe.outcome = IdentityProbeOutcome(state="invalid", detail="上游登录态已失效")

    with pytest.raises(BadRequestError) as exc:
        managed_service.create_account(
            service_db,
            {
                "platform_id": platform["id"],
                "name": "投放一号",
                "auth_mode": "cookie",
                "cookie_bundle": [dict(_COOKIE)],
            },
        )

    assert "Cookie 校验失败" in exc.value.detail
    assert probe.calls == 1
    # 确定失效的 Cookie 不得进入账号池。
    with service_db.session() as session:
        assert session.query(ManagedPlatformAccount).count() == 0


def test_cookie_account_persists_with_initial_state(
    service_db: Database, probe: ProbeStub
) -> None:
    platform = _platform(service_db)
    audit = AuditContext(actor_type="admin", actor_id=1, actor_username="boss")

    result = managed_service.create_account(
        service_db,
        {
            "platform_id": platform["id"],
            "name": "投放一号",
            "auth_mode": "cookie",
            "cookie_bundle": [dict(_COOKIE)],
        },
        audit=audit,
    )

    assert result["credentialVersion"] == 1
    assert result["sessionStatus"] == "valid"
    item = _account(service_db, result["id"])
    assert item.auth_mode == "cookie"
    assert item.cookie_bundle == [dict(_COOKIE)]
    assert item.auto_relogin is False  # cookie 账号永远不做自动恢复登录
    assert item.recovery_status == "idle"
    with service_db.session() as session:
        row = session.query(UserLog).one()
    assert row.action == "MANAGED_ACCOUNT_CREATED"
    assert row.target_type == "managed_platform_account"
    assert row.target_id == result["id"]


def test_password_recovery_policy_cannot_be_disabled_by_service_values(
    service_db: Database, probe: ProbeStub,
) -> None:
    platform = _platform(service_db)
    account = managed_service.create_account(service_db, {
        "platform_id": platform["id"], "name": "强制自动恢复", "auth_mode": "server_login",
        "username": "test-email", "password": "test-password", "auto_relogin": False,
    })
    assert account["autoRelogin"] is True
    assert account["sessionStatus"] == "expired"
    assert account["recoveryStatus"] == "pending"
    updated = managed_service.update_account(service_db, account["id"], {"auto_relogin": False})
    assert updated["autoRelogin"] is True
    assert updated["recoveryStatus"] == "pending"
    assert updated["nextRecoveryAt"] == account["nextRecoveryAt"]
    assert updated["credentialVersion"] == account["credentialVersion"]


def test_disabled_worker_rejects_new_password_credentials_without_disabling_account_policy(
    service_db: Database, probe: ProbeStub, monkeypatch: pytest.MonkeyPatch,
) -> None:
    account, user = _bound_account(service_db, auth_mode="server_login")
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "0")
    with pytest.raises(ManagedProviderUnavailableError, match="自动恢复服务未启用"):
        managed_service.create_account(service_db, {
            "platform_id": account["platformId"], "name": "服务关闭时的新账号", "auth_mode": "server_login",
            "username": "new-user", "password": "new-password",
        })
    with pytest.raises(ManagedProviderUnavailableError, match="自动恢复服务未启用"):
        managed_service.update_account(service_db, account["id"], {"password": "new-password"})
    after = managed_service.get_account(service_db, account["id"])
    assert after["autoRelogin"] is True
    assert after["credentialVersion"] == account["credentialVersion"]
    assert after["recoveryStatus"] == account["recoveryStatus"]
    assert len(managed_service.list_accounts(service_db)) == 1
    renamed = managed_service.update_account(service_db, account["id"], {"name": "只修改别名"})
    assert renamed["autoRelogin"] is True
    assert renamed["recoveryAttempts"] == account["recoveryAttempts"]
    assert renamed["nextRecoveryAt"] == account["nextRecoveryAt"]


def test_password_recovery_stops_at_retry_limit_and_only_new_credentials_restart_it(
    service_db: Database, probe: ProbeStub, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.db.base import utc_now
    from app.services import managed_recovery
    from app.services.managed_platforms import ManagedLoginResult

    account, user = _bound_account(service_db, auth_mode="server_login")
    now = utc_now() + timedelta(seconds=1)
    monkeypatch.setattr(managed_recovery, "utc_now", lambda: now)

    class UnavailableProvider:
        def verify(self, **kwargs: Any) -> ManagedLoginResult:
            return ManagedLoginResult("unavailable", [])

    for attempt in range(1, 4):
        assert managed_recovery.run_recovery(service_db, account["id"], provider=UnavailableProvider()) is False
        after = managed_service.get_account(service_db, account["id"])
        assert after["recoveryAttempts"] == attempt
        assert after["sessionStatus"] == "expired"
        assert after["recoveryStatus"] == ("retry_wait" if attempt < 3 else "failed")
        if attempt < 3:
            assert after["nextRecoveryAt"] is not None
            assert managed_recovery.run_recovery(service_db, account["id"], provider=UnavailableProvider()) is False
            assert managed_service.get_account(service_db, account["id"])["recoveryAttempts"] == attempt
        else:
            assert after["nextRecoveryAt"] is None
        now += timedelta(seconds=20)

    renamed = managed_service.update_account(service_db, account["id"], {"name": "失败后的别名"})
    assert renamed["autoRelogin"] is True
    assert renamed["recoveryStatus"] == "failed"
    assert renamed["recoveryAttempts"] == 3
    assert managed_recovery.run_recovery(service_db, account["id"], provider=UnavailableProvider()) is False
    rotated = managed_service.update_account(service_db, account["id"], {"password": "replacement-password"})
    assert rotated["recoveryStatus"] == "pending"
    assert rotated["recoveryAttempts"] == 0
    assert rotated["credentialVersion"] == account["credentialVersion"] + 1
    assert rotated["sessionStatus"] == "expired"


@pytest.mark.parametrize("state", ["invalid_credentials", "needs_manual_verification"])
def test_password_recovery_terminal_failure_is_not_reset_by_metadata_edits(
    service_db: Database, probe: ProbeStub, state: str,
) -> None:
    from app.services.managed_platforms import ManagedLoginResult
    from app.services.managed_recovery import run_recovery

    account, user = _bound_account(service_db, auth_mode="server_login")

    class Provider:
        def verify(self, **kwargs: Any) -> ManagedLoginResult:
            return ManagedLoginResult(state, [])

    assert run_recovery(service_db, account["id"], provider=Provider()) is False
    before = managed_service.get_account(service_db, account["id"])
    after = managed_service.update_account(service_db, account["id"], {"name": "只改展示信息"})
    for key in ("recoveryStatus", "recoveryAttempts", "lastError", "nextRecoveryAt", "credentialVersion"):
        assert after[key] == before[key]
    assert after["recoveryStatus"] == "failed"
    assert after["autoRelogin"] is True
    assert run_recovery(service_db, account["id"], provider=Provider()) is False


@pytest.mark.parametrize("status", ["active", "invalid", "revoked"])
def test_legacy_false_policy_normalization_does_not_restart_a_failed_attempt(
    service_db: Database, probe: ProbeStub, status: str,
) -> None:
    account, user = _bound_account(service_db, auth_mode="server_login")
    # Synthetic pre-migration row: changing policy alone must not erase terminal state.
    with service_db.session() as session:
        row = session.get(ManagedPlatformAccount, account["id"])
        row.auto_relogin = False
        row.status = status
        row.recovery_status = "failed"
        row.recovery_attempts = 3
        row.last_error = "历史恢复失败"
        row.next_recovery_at = None
    before = managed_service.get_account(service_db, account["id"])
    after = managed_service.update_account(service_db, account["id"], {"name": "历史账号改名"})
    assert after["autoRelogin"] is True
    for key in ("recoveryStatus", "recoveryAttempts", "lastError", "nextRecoveryAt", "credentialVersion", "sessionStatus"):
        assert after[key] == before[key]


def test_disabling_password_account_cancels_pending_recovery(
    service_db: Database, probe: ProbeStub,
) -> None:
    account, user = _bound_account(service_db, auth_mode="server_login")
    assert account["recoveryStatus"] == "pending"
    disabled = managed_service.update_account(service_db, account["id"], {"status": "invalid"})
    assert disabled["status"] == "invalid"
    assert disabled["autoRelogin"] is True
    assert disabled["recoveryStatus"] == "idle"
    assert disabled["nextRecoveryAt"] is None

    from app.services.managed_recovery import run_recovery

    class Provider:
        def verify(self, **kwargs: Any) -> Any:
            raise AssertionError("disabled accounts must never attempt login")

    assert run_recovery(service_db, account["id"], provider=Provider()) is False


def test_alias_conflict_within_platform_is_conflict(
    service_db: Database, probe: ProbeStub
) -> None:
    platform = _platform(service_db)
    values = {
        "platform_id": platform["id"],
        "name": "投放一号",
        "auth_mode": "cookie",
        "cookie_bundle": [dict(_COOKIE)],
    }
    managed_service.create_account(service_db, dict(values))

    with pytest.raises(ConflictError):
        managed_service.create_account(service_db, dict(values))


def test_refresh_marks_expired_and_skips_recovery_for_cookie_accounts(
    service_db: Database, probe: ProbeStub
) -> None:
    account, user = _bound_account(service_db, auth_mode="cookie")
    probe.outcome = IdentityProbeOutcome(state="invalid")

    managed_service.refresh_session_statuses(service_db, user["id"])

    item = _account(service_db, account["id"])
    assert item.session_status == "expired"
    assert item.last_error == "自动校验：上游会话已失效"
    # cookie 账号只收紧状态,不进入恢复队列:没有人能替它自动重登。
    assert item.recovery_status == "idle"


def test_refresh_keeps_status_when_probe_is_unavailable(
    service_db: Database, probe: ProbeStub
) -> None:
    account, user = _bound_account(service_db, auth_mode="cookie")
    probe.outcome = None  # 网络失败:未知即不动

    managed_service.refresh_session_statuses(service_db, user["id"])

    item = _account(service_db, account["id"])
    assert item.session_status == "valid"
    assert item.last_error is None


def test_refresh_caches_valid_conclusion_across_calls(
    service_db: Database, probe: ProbeStub
) -> None:
    account, user = _bound_account(service_db, auth_mode="cookie")
    probe.outcome = IdentityProbeOutcome(state="verified", remote_account_id="888")

    # create_account 阶段已探过一次,从这里开始只统计 refresh 的上游调用。
    probe.calls = 0
    managed_service.refresh_session_statuses(service_db, user["id"])
    assert probe.calls == 1

    # 第二次探测被 (account_id, credential_version) 缓存挡下,不再打上游。
    probe.outcome = None
    managed_service.refresh_session_statuses(service_db, user["id"])
    assert probe.calls == 1
    assert _account(service_db, account["id"]).session_status == "valid"


def test_refresh_queues_recovery_for_logged_in_server_login_account(
    service_db: Database, probe: ProbeStub
) -> None:
    account, user = _bound_account(service_db, auth_mode="server_login")
    with service_db.session() as session:
        item = session.get(ManagedPlatformAccount, account["id"])
        assert item.auto_relogin is True  # recovery_enabled + server_login 的新账号
        # 模拟完成首次自动登录:持有会话 Cookie,恢复队列清空,会话视为有效。
        item.cookie_bundle = [dict(_COOKIE)]
        item.session_status = "valid"
        item.recovery_status = "idle"
    probe.outcome = IdentityProbeOutcome(state="invalid")

    managed_service.refresh_session_statuses(service_db, user["id"])

    item = _account(service_db, account["id"])
    assert item.session_status == "expired"
    assert item.recovery_status == "pending"
    assert item.next_recovery_at is not None
