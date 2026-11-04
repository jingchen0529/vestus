"""Service-layer tests for ``app.services.admins``.

Pins the super-admin safety net: the last active super administrator can be
neither demoted, disabled nor deleted, nobody may disable or delete themselves,
and deleting an ordinary administrator releases the desktop users they owned
instead of leaving dangling bindings.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from app.db.models import Admin, User, UserLog
from app.db.session import Database
from app.services import admins as admins_service
from app.services import users as users_service
from app.services.audit import AuditContext
from app.services.errors import (
    BadRequestError,
    ConflictError,
    LastSuperAdminError,
    NotFoundError,
)

SUPER_VALUES = {
    "username": "super-1",
    "name": "超管一号",
    "password": "super-password-1",
    "role": "super_admin",
}
PLAIN_VALUES = {
    "username": "plain-1",
    "name": "普通管理员",
    "password": "plain-password-1",
    "role": "admin",
}
AUDIT = AuditContext(actor_type="admin", actor_id=1, actor_username="tester")

#: service_db 初始化时 bootstrap 出来的唯一超管(conftest 环境变量)。
BOOTSTRAP_USERNAME = "test-admin"


def _admin_row(service_db: Database, username: str) -> Admin:
    with service_db.session() as session:
        return session.query(Admin).filter_by(username=username).one()


def test_duplicate_username_is_conflict(service_db: Database) -> None:
    admins_service.create_admin(service_db, dict(PLAIN_VALUES))

    with pytest.raises(ConflictError):
        admins_service.create_admin(service_db, dict(PLAIN_VALUES))


def test_last_super_admin_cannot_be_demoted(service_db: Database) -> None:
    bootstrap = _admin_row(service_db, BOOTSTRAP_USERNAME)

    with pytest.raises(BadRequestError) as exc:
        admins_service.update_admin(service_db, bootstrap.id, {"role": "admin"})

    assert exc.value.detail == admins_service.LAST_SUPER_ADMIN_DEMOTE_DETAIL
    assert _admin_row(service_db, BOOTSTRAP_USERNAME).role == "super_admin"


def test_last_super_admin_cannot_be_disabled(service_db: Database) -> None:
    bootstrap = _admin_row(service_db, BOOTSTRAP_USERNAME)

    with pytest.raises(BadRequestError) as exc:
        admins_service.update_admin(service_db, bootstrap.id, {"status": "disabled"})
    assert exc.value.detail == admins_service.LAST_SUPER_ADMIN_DISABLE_DETAIL

    with pytest.raises(BadRequestError) as exc:
        admins_service.disable_admin(
            service_db, bootstrap.id, actor_admin_id=bootstrap.id + 1
        )
    assert exc.value.detail == admins_service.LAST_SUPER_ADMIN_DISABLE_DETAIL


def test_last_super_admin_cannot_be_deleted(service_db: Database) -> None:
    bootstrap = _admin_row(service_db, BOOTSTRAP_USERNAME)

    with pytest.raises(LastSuperAdminError):
        admins_service.delete_admin(
            service_db, bootstrap.id, actor_admin_id=bootstrap.id + 1
        )


def test_demotion_is_allowed_once_a_second_super_admin_exists(service_db: Database) -> None:
    second = admins_service.create_admin(service_db, dict(SUPER_VALUES))

    admins_service.update_admin(service_db, second["id"], {"role": "admin"})

    assert _admin_row(service_db, SUPER_VALUES["username"]).role == "admin"


def test_nobody_may_disable_or_delete_themselves(service_db: Database) -> None:
    plain = admins_service.create_admin(service_db, dict(PLAIN_VALUES))

    with pytest.raises(BadRequestError) as exc:
        admins_service.disable_admin(service_db, plain["id"], actor_admin_id=plain["id"])
    assert exc.value.detail == admins_service.SELF_DISABLE_DETAIL

    with pytest.raises(BadRequestError) as exc:
        admins_service.delete_admin(service_db, plain["id"], actor_admin_id=plain["id"])
    assert exc.value.detail == admins_service.SELF_DELETE_DETAIL


def test_deleting_an_admin_releases_their_bound_users(service_db: Database) -> None:
    plain = admins_service.create_admin(service_db, dict(PLAIN_VALUES))
    user = users_service.create_user(
        service_db,
        {
            "username": "op1",
            "name": "运营一号",
            "password": "password-1",
            "bound_admin_id": plain["id"],
        },
    )

    assert admins_service.delete_admin(service_db, plain["id"], audit=AUDIT) is True

    with service_db.session() as session:
        user_row = session.get(User, user["id"])
        log_row = session.query(UserLog).one()
    # 遗留绑定会让这些用户只有超管看得见,且每次编辑都报「管理员不存在」。
    assert user_row.bound_admin_id is None
    assert log_row.action == "ADMIN_DELETE"
    assert log_row.details["releasedUsers"] == 1
    assert "已解绑其名下 1 个用户" in log_row.summary


def test_reset_password_rotates_admin_credentials(service_db: Database) -> None:
    plain = admins_service.create_admin(service_db, dict(PLAIN_VALUES))

    admins_service.reset_password(service_db, plain["id"], "rotated-pass-9", audit=AUDIT)

    row = _admin_row(service_db, PLAIN_VALUES["username"])
    assert row.token_version == 2
    assert row.password_changed_at is not None
    with service_db.session() as session:
        assert session.query(UserLog).one().action == "ADMIN_RESET_PASSWORD"
    with pytest.raises(NotFoundError):
        admins_service.reset_password(service_db, 9999, "whatever")
