"""Service-layer tests for ``app.services.auth``.

Pins the login contract at the service seam: rejection order, the deliberate
administrator lockout exemption, the commit-then-raise audit shape (a failed
login still lands its FAILED row), and credential rotation through
``change_password`` / ``logout``.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict

import pytest

from app.core.config import get_settings
from app.db.base import utc_now
from app.db.models import Admin, User, UserLog
from app.db.session import Database
from app.services import auth as auth_service
from app.services import users as users_service
from app.services.audit import AuditContext
from app.services.errors import AccountUnavailableError, AuthenticationError, BadRequestError

ADMIN_USERNAME = "test-admin"
ADMIN_PASSWORD = "test-admin-password"
USER_VALUES = {"username": "op1", "name": "运营一号", "password": "password-1"}
AUDIT = AuditContext(actor_type="admin", actor_id=1, actor_username="tester", ip="203.0.113.5")


def _user(service_db: Database, **overrides: Any) -> Dict[str, Any]:
    return users_service.create_user(service_db, {**USER_VALUES, **overrides})


def _user_row(service_db: Database, user_id: int) -> User:
    with service_db.session() as session:
        return session.get(User, user_id)


def _audit_rows(service_db: Database) -> list[UserLog]:
    with service_db.session() as session:
        return list(session.query(UserLog).all())


def test_admin_login_returns_bearer_grant(service_db: Database) -> None:
    grant = auth_service.login(
        service_db, "admin", ADMIN_USERNAME, ADMIN_PASSWORD, audit=AUDIT
    )

    assert isinstance(grant.token, str) and grant.token
    assert grant.payload["token_type"] == "bearer"
    assert grant.payload["admin"]["username"] == ADMIN_USERNAME
    assert grant.ttl_seconds == get_settings().access_token_ttl_seconds

    with service_db.session() as session:
        admin = session.query(Admin).filter_by(username=ADMIN_USERNAME).one()
    assert admin.last_login_at is not None
    rows = _audit_rows(service_db)
    assert any(row.action == "LOGIN" and row.status == "SUCCESS" for row in rows)


def test_wrong_password_counts_failure_and_writes_failed_row(service_db: Database) -> None:
    user = _user(service_db)

    # login 是 commit-then-raise:异常抛出前,FAILED 审计行已经落库。
    with pytest.raises(AuthenticationError) as exc:
        auth_service.login(
            service_db, "user", user["username"], "wrong-password", audit=AUDIT
        )

    assert exc.value.detail == auth_service.INVALID_CREDENTIALS_DETAIL
    assert _user_row(service_db, user["id"]).failed_login_count == 1
    rows = _audit_rows(service_db)
    assert len(rows) == 1
    assert rows[0].action == "LOGIN"
    assert rows[0].status == "FAILED"
    assert "密码错误" in rows[0].summary


def test_unknown_account_is_indistinguishable_from_wrong_password(service_db: Database) -> None:
    with pytest.raises(AuthenticationError) as exc:
        auth_service.login(service_db, "user", "ghost", "whatever", audit=AUDIT)

    # 与密码错误同一个 detail,不向外界泄漏「这个用户名存在」。
    assert exc.value.detail == auth_service.INVALID_CREDENTIALS_DETAIL
    rows = _audit_rows(service_db)
    assert len(rows) == 1 and "账号不存在" in rows[0].summary


def test_disabled_user_cannot_login(service_db: Database) -> None:
    user = _user(service_db)
    users_service.disable_user(service_db, user["id"])

    with pytest.raises(AccountUnavailableError) as exc:
        auth_service.login(
            service_db, "user", user["username"], USER_VALUES["password"], audit=AUDIT
        )

    assert exc.value.detail == auth_service.ACCOUNT_UNAVAILABLE_DETAIL


def test_expired_user_cannot_login(service_db: Database) -> None:
    user = _user(service_db, expires_at="2026-01-01")  # end_of_day,已过去

    with pytest.raises(AccountUnavailableError) as exc:
        auth_service.login(
            service_db, "user", user["username"], USER_VALUES["password"], audit=AUDIT
        )

    assert exc.value.detail == auth_service.ACCOUNT_EXPIRED_DETAIL


def test_repeated_failures_lock_account_and_lockout_refuses_correct_password(
    service_db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VESTUS_LOGIN_MAX_ATTEMPTS", "2")
    user = _user(service_db)

    for _ in range(2):
        with pytest.raises(AuthenticationError):
            auth_service.login(
                service_db, "user", user["username"], "wrong-password", audit=AUDIT
            )
    locked = _user_row(service_db, user["id"])
    assert locked.locked_until is not None

    # 锁定期间连正确密码也拒绝;且锁定拒绝不再补审计行——
    # 锁定本身就是前两次失败记录的后果,再记只会灌水。
    rows_before = len(_audit_rows(service_db))
    with pytest.raises(AccountUnavailableError) as exc:
        auth_service.login(
            service_db, "user", user["username"], USER_VALUES["password"], audit=AUDIT
        )
    assert exc.value.detail == auth_service.ACCOUNT_LOCKED_DETAIL
    assert len(_audit_rows(service_db)) == rows_before


def test_lockout_expires_then_success_resets_counters(service_db: Database) -> None:
    user = _user(service_db)
    with service_db.session() as session:
        item = session.get(User, user["id"])
        item.failed_login_count = 2
        item.locked_until = utc_now() - timedelta(seconds=1)  # 锁定已过期

    grant = auth_service.login(
        service_db,
        "user",
        user["username"],
        USER_VALUES["password"],
        device_id="device-abc",
        audit=AUDIT,
    )

    assert grant.payload["token_type"] == "bearer"
    item = _user_row(service_db, user["id"])
    assert item.failed_login_count == 0
    assert item.locked_until is None
    assert item.last_device_id == "device-abc"
    assert item.last_login_at is not None


def test_admin_is_deliberately_exempt_from_lockout(
    service_db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 设计取舍:把唯一超管锁在控制台外,比暴力破解风险更糟(审计日志兜底)。
    monkeypatch.setenv("VESTUS_LOGIN_MAX_ATTEMPTS", "2")
    for _ in range(5):
        with pytest.raises(AuthenticationError) as exc:
            auth_service.login(
                service_db, "admin", ADMIN_USERNAME, "wrong-password", audit=AUDIT
            )
        assert type(exc.value) is AuthenticationError  # 永远不是 AccountUnavailableError


def test_logout_bumps_token_version_and_audits(service_db: Database) -> None:
    user = _user(service_db)

    auth_service.logout(service_db, "user", user["id"], audit=AUDIT)

    assert _user_row(service_db, user["id"]).token_version == 2
    rows = _audit_rows(service_db)
    assert any(row.action == "LOGOUT" and row.status == "SUCCESS" for row in rows)


def test_change_password_refuses_wrong_current_and_still_audits(service_db: Database) -> None:
    user = _user(service_db)

    # 同样的 commit-then-raise:错当前密码,FAILED 行也要落库。
    with pytest.raises(BadRequestError) as exc:
        auth_service.change_password(
            service_db, user["id"], "wrong-current", "new-pass-1", audit=AUDIT
        )

    assert exc.value.detail == auth_service.WRONG_CURRENT_PASSWORD_DETAIL
    rows = _audit_rows(service_db)
    assert any(row.action == "CHANGE_PASSWORD" and row.status == "FAILED" for row in rows)
    # 旧密码依然有效。
    grant = auth_service.login(
        service_db, "user", user["username"], USER_VALUES["password"]
    )
    assert grant.payload["token_type"] == "bearer"


def test_change_password_rotates_credentials(service_db: Database) -> None:
    user = _user(service_db, must_change_password=True)

    auth_service.change_password(
        service_db, user["id"], USER_VALUES["password"], "brand-new-pass", audit=AUDIT
    )

    item = _user_row(service_db, user["id"])
    assert item.token_version == 2  # 旧 token 全部失效
    assert item.must_change_password is False
    with pytest.raises(AuthenticationError):
        auth_service.login(service_db, "user", user["username"], USER_VALUES["password"])
    grant = auth_service.login(service_db, "user", user["username"], "brand-new-pass")
    assert grant.payload["token_type"] == "bearer"
    rows = _audit_rows(service_db)
    assert any(row.action == "CHANGE_PASSWORD" and row.status == "SUCCESS" for row in rows)
