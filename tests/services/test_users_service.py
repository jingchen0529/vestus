"""Service-layer tests for ``app.services.users``.

Pins the tenancy rules that keep plain administrators inside their own user
list: the two privileged fields are super-admin only, password resets revoke
tokens, and deletion is soft so existing sessions die through token_version.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from app.core.security import hash_password
from app.db.models import Admin, User, UserLog
from app.db.session import Database
from app.services import users as users_service
from app.services.audit import AuditContext
from app.services.errors import ConflictError, ForbiddenFieldError, NotFoundError

USER_VALUES = {"username": "op1", "name": "运营一号", "password": "password-1"}


def _make_admin(service_db: Database, username: str) -> int:
    """Arrange an admin row directly: admins are another domain's aggregate."""
    with service_db.session() as session:
        admin = Admin(
            username=username,
            name=username,
            password_hash=hash_password("pw-123456"),
            role="admin",
        )
        session.add(admin)
        session.flush()
        return int(admin.id)


def _make_bound_user(service_db: Database, admin_id: int, username: str = "op1") -> Dict[str, Any]:
    return users_service.create_user(
        service_db, {**USER_VALUES, "username": username, "bound_admin_id": admin_id}
    )


def _user_row(service_db: Database, user_id: int) -> User:
    with service_db.session() as session:
        return session.get(User, user_id)


def test_duplicate_username_is_conflict(service_db: Database) -> None:
    users_service.create_user(service_db, dict(USER_VALUES))

    with pytest.raises(ConflictError):
        users_service.create_user(service_db, dict(USER_VALUES))


def test_create_user_writes_audit_row(service_db: Database) -> None:
    audit = AuditContext(actor_type="admin", actor_id=1, actor_username="boss")

    result = users_service.create_user(service_db, dict(USER_VALUES), audit=audit)

    with service_db.session() as session:
        row = session.query(UserLog).one()
    assert row.action == "USER_CREATE"
    assert row.target_id == result["id"]


def test_plain_admin_cannot_rewrite_tenancy_fields(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    admin_b = _make_admin(service_db, "admin-b")
    user = _make_bound_user(service_db, admin_a)

    with pytest.raises(ForbiddenFieldError):
        users_service.update_user(
            service_db, user["id"], {"bound_admin_id": admin_b}, visible_admin_id=admin_a
        )
    with pytest.raises(ForbiddenFieldError):
        users_service.update_user(
            service_db, user["id"], {"proxy_id": 1}, visible_admin_id=admin_a
        )

    # 拒绝发生在写入之前:绑定关系保持原样,没有半次移交。
    assert _user_row(service_db, user["id"]).bound_admin_id == admin_a


def test_super_admin_can_rebind_user(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    admin_b = _make_admin(service_db, "admin-b")
    user = _make_bound_user(service_db, admin_a)

    users_service.update_user(service_db, user["id"], {"bound_admin_id": admin_b})

    assert _user_row(service_db, user["id"]).bound_admin_id == admin_b


def test_disable_and_enable_roundtrip(service_db: Database) -> None:
    audit = AuditContext(actor_type="admin", actor_id=1, actor_username="boss")
    user = users_service.create_user(service_db, dict(USER_VALUES))

    users_service.disable_user(service_db, user["id"], audit=audit)
    assert _user_row(service_db, user["id"]).status == "disabled"
    with service_db.session() as session:
        assert "USER_DISABLE" in [row.action for row in session.query(UserLog)]

    users_service.enable_user(service_db, user["id"], audit=audit)
    item = _user_row(service_db, user["id"])
    assert item.status == "active"
    assert item.failed_login_count == 0  # 启用同时清除失败锁定


def test_reset_password_revokes_tokens_and_audits(service_db: Database) -> None:
    audit = AuditContext(actor_type="admin", actor_id=1, actor_username="boss")
    user = users_service.create_user(
        service_db, {**USER_VALUES, "must_change_password": True}
    )
    old_hash = _user_row(service_db, user["id"]).password_hash

    users_service.reset_password(service_db, user["id"], "brand-new-pass", audit=audit)

    item = _user_row(service_db, user["id"])
    assert item.password_hash != old_hash
    assert item.must_change_password is False
    assert item.token_version == 2  # 密码变更使已发放的旧 token 全部失效
    with service_db.session() as session:
        assert "USER_RESET_PASSWORD" in [row.action for row in session.query(UserLog)]


def test_delete_user_is_soft_and_revokes_tokens(service_db: Database) -> None:
    user = users_service.create_user(service_db, dict(USER_VALUES))

    assert users_service.delete_user(service_db, user["id"]) is True

    item = _user_row(service_db, user["id"])
    assert item.deleted_at is not None
    assert item.status == "disabled"
    assert item.token_version == 2
    # 软删除后 get_active 查不到:再次删除即 NotFound,而不是二次删除同一行。
    with pytest.raises(NotFoundError):
        users_service.delete_user(service_db, user["id"])
