"""Service-layer tests for ``app.services.browser_activity``.

Pins the delta contract (batches add, retries never rewrite), the v2 receipt
(idempotent per batch id, conflict on content change), the owner/binding
checks, and the tenancy scoping of the read side.  The HTTP shape is already
covered by tests/api; these tests drive the service seam directly.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from app.core.security import hash_password
from app.db.models import Admin, BrowserSession, User
from app.db.session import Database
from app.schemas.browser_activity import BrowserActivityReportV2
from app.services import browser_activity as activity_service
from app.services import managed_platforms as managed_service
from app.services import platforms as platforms_service
from app.services import users as users_service
from app.services.errors import ConflictError, ForbiddenFieldError, NotFoundError

SESSION_KEY = "0000018f2c4a1b3d000012340000002a"
BATCH_A = "a" * 64
BATCH_B = "b" * 64


def _user(service_db: Database, username: str = "op1", **extra: Any) -> Dict[str, Any]:
    return users_service.create_user(
        service_db,
        {"username": username, "name": username, "password": "password-1", **extra},
    )


def _page(url: str = "https://ad.oceanengine.com/ads") -> Dict[str, Any]:
    return {
        "url": url,
        "visits": 1,
        "clicks": 2,
        "inputs": 3,
        "scrolls": 1,
        "dwellMs": 1000,
        "firstSeenAtMs": 1700000000000,
        "lastSeenAtMs": 1700000001000,
    }


def _v2(user_id: int, *, batch_id: str = BATCH_A, **overrides: Any) -> BrowserActivityReportV2:
    return BrowserActivityReportV2.model_validate(
        {
            "sessionKey": SESSION_KEY,
            "browserId": 1,
            "platformId": 1,
            "directMode": True,
            "reportedAtMs": 1700000002000,
            "pages": [_page()],
            "batchId": batch_id,
            "ownerUserId": user_id,
            "protocolVersion": 2,
            **overrides,
        }
    )


def _session(service_db: Database) -> BrowserSession:
    with service_db.session() as session:
        return session.query(BrowserSession).one()


def test_batches_add_up_instead_of_rewriting(service_db: Database) -> None:
    user = _user(service_db)

    first = activity_service.record_activity(
        service_db, _v2(user["id"], batch_id=BATCH_A), user_id=user["id"], username="op1"
    )
    second = activity_service.record_activity(
        service_db, _v2(user["id"], batch_id=BATCH_B), user_id=user["id"], username="op1"
    )

    assert first["sessionId"] == second["sessionId"]
    item = _session(service_db)
    assert item.visits == 2  # 两个批次各一次访问:增量累加
    assert item.clicks == 4
    # 第二批是同一地址:增量并入已有页面行,不算新页面。
    assert first["newPages"] == 1
    assert second["newPages"] == 0


def test_duplicate_v2_batch_is_idempotent(service_db: Database) -> None:
    user = _user(service_db)
    activity_service.record_activity(
        service_db, _v2(user["id"]), user_id=user["id"], username="op1"
    )

    replay = activity_service.record_activity(
        service_db, _v2(user["id"]), user_id=user["id"], username="op1"
    )

    assert replay["acknowledged"] is True
    assert replay["newPages"] == 0
    assert _session(service_db).visits == 1  # 重放不叠加


def test_same_batch_id_with_different_content_is_conflict(service_db: Database) -> None:
    user = _user(service_db)
    activity_service.record_activity(
        service_db, _v2(user["id"]), user_id=user["id"], username="op1"
    )

    with pytest.raises(ConflictError):
        activity_service.record_activity(
            service_db,
            _v2(user["id"], pages=[_page("https://ad.oceanengine.com/other")]),
            user_id=user["id"],
            username="op1",
        )


def test_report_must_belong_to_the_authenticated_user(service_db: Database) -> None:
    owner = _user(service_db, "owner")
    other = _user(service_db, "other")

    with pytest.raises(ForbiddenFieldError):
        activity_service.record_activity(
            service_db, _v2(owner["id"]), user_id=other["id"], username="other"
        )


def test_session_cannot_switch_managed_account(service_db: Database) -> None:
    user = _user(service_db)
    activity_service.record_activity(
        service_db, _v2(user["id"], managedAccountId=None), user_id=user["id"], username="op1"
    )

    with pytest.raises(ForbiddenFieldError):
        activity_service.record_activity(
            service_db, _v2(user["id"], batch_id=BATCH_B, managedAccountId=5),
            user_id=user["id"], username="op1",
        )


def test_unbound_managed_account_is_refused(service_db: Database) -> None:
    platform = platforms_service.create_platform(
        service_db, {"name": "巨量引擎", "url": "https://ad.oceanengine.com"}
    )
    account = managed_service.create_account(
        service_db,
        {
            "platform_id": platform["id"],
            "name": "投放一号",
            "auth_mode": "server_login",
            "username": "ad-ops",
            "password": "pw-123456",
        },
    )
    user = _user(service_db)  # 没有绑定这个托管账号

    with pytest.raises(ForbiddenFieldError):
        activity_service.record_activity(
            service_db,
            _v2(
                user["id"],
                platformId=platform["id"],
                managedAccountId=account["id"],
            ),
            user_id=user["id"],
            username="op1",
        )


def test_plain_admin_only_sees_bound_users_sessions(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    admin_b = _make_admin(service_db, "admin-b")
    user_a = _user(service_db, "op1", bound_admin_id=admin_a)
    user_b = _user(service_db, "op2", bound_admin_id=admin_b)
    result_a = activity_service.record_activity(
        service_db, _v2(user_a["id"]), user_id=user_a["id"], username="op1"
    )
    result_b = activity_service.record_activity(
        service_db, _v2(user_b["id"]), user_id=user_b["id"], username="op2"
    )

    scoped = activity_service.list_sessions(service_db, visible_admin_id=admin_a)
    assert scoped["total"] == 1
    assert scoped["items"][0]["id"] == result_a["sessionId"]

    # 跨租户的会话详情一律 NotFound,不泄漏存在性;超管不受租户限制。
    with pytest.raises(NotFoundError):
        activity_service.get_session_detail(
            service_db, result_b["sessionId"], visible_admin_id=admin_a
        )
    assert (
        activity_service.get_session_detail(service_db, result_b["sessionId"])["id"]
        == result_b["sessionId"]
    )
    assert activity_service.list_sessions(service_db)["total"] == 2


def _make_admin(service_db: Database, username: str) -> int:
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
