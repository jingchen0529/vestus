from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from tests.api.test_managed_platforms import (
    _bearer,
    _consume_bootstrap,
    _cookie_account_with_binding,
    _issue_bootstrap,
    _setup,
)
from tests.envelope import payload


@pytest.fixture()
def launched(api: Any, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, str, str, dict, int, dict]:
    from app.services import managed_platforms as service
    from app.services.managed_identity import IdentityProbeOutcome

    monkeypatch.setattr(service, "_identity_probe", lambda *args: IdentityProbeOutcome(
        "verified", remote_account_id="original-remote", remote_display_name="原巨量账号",
    ))
    client, _module = api
    admin, user, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin, platform)
    grant = _issue_bootstrap(client, user, platform, account_id, "a1b2c3d4")
    consumed = _consume_bootstrap(client, user, platform, grant, "a1b2c3d4")
    return client, admin, user, platform, account_id, consumed


def body(platform: dict, account_id: int, consumed: dict, **changes: Any) -> dict:
    return {
        "sessionKey": "identity-snapshot-session", "browserId": 1, "platformId": platform["id"],
        "managedAccountId": account_id, "bootstrapSessionId": consumed["sessionId"], "deviceId": "a1b2c3d4",
        "batchId": hashlib.sha256(b"original").hexdigest(), "ownerUserId": 1, "protocolVersion": 2,
        "pages": [{"url": "https://localads.chengzijianzhan.cn/lamp/pc/project", "urlParams": "advid=123456", "visits": 1}],
        **changes,
    }


def test_delayed_first_report_uses_consumed_identity_not_current_credentials(launched: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import managed_platforms as service
    from app.services.managed_identity import IdentityProbeOutcome

    client, admin, user, platform, account_id, consumed = launched
    monkeypatch.setattr(service, "_identity_probe", lambda *args: IdentityProbeOutcome(
        "verified", remote_account_id="replacement-remote", remote_display_name="替换后的巨量账号",
    ))
    rotated = client.patch(f"/api/admin/managed-platform-accounts/{account_id}", headers=_bearer(admin), json={
        "cookieBundle": [{"name": "sessionid", "value": "replacement", "domain": ".example.test"}],
    })
    assert rotated.status_code == 200, rotated.text
    reported = client.post("/api/user/browser-activity/v2", headers=_bearer(user), json=body(platform, account_id, consumed))
    assert reported.status_code == 200, reported.text
    associations = client.get(f"/api/admin/advertiser-accounts/{platform['id']}/123456/associations", headers=_bearer(admin))
    assert associations.status_code == 200, associations.text
    row = payload(associations)["items"][0]
    assert row["remoteAccountId"] == "original-remote"
    assert row["managedAccountName"] == "原巨量账号"
    assert row["credentialVersion"] == consumed["credentialVersion"]
    assert row["identitySource"] == "bootstrap"


@pytest.mark.parametrize("changes", [
    {"bootstrapSessionId": "9223372036854775807"}, {"deviceId": "b1b2c3d4"},
    {"platformId": 999}, {"managedAccountId": None},
])
def test_invalid_startup_identity_is_not_silently_downgraded(launched: Any, changes: dict) -> None:
    client, _admin, user, platform, account_id, consumed = launched
    response = client.post("/api/user/browser-activity/v2", headers=_bearer(user), json=body(platform, account_id, consumed, **changes))
    assert response.status_code == 403, response.text


def test_other_users_ticket_and_switching_session_identity_are_rejected(launched: Any) -> None:
    client, admin, user, platform, account_id, consumed = launched
    second = _issue_bootstrap(client, user, platform, account_id, "a1b2c3d4")
    # The original consumed identity is valid, but its ID cannot authorize another user.
    created = client.post("/api/admin/users", headers=_bearer(admin), json={
        "username": "another-reporter", "password": "test-password", "name": "其他用户", "expiresAt": "2099-12-31",
    })
    assert created.status_code == 201
    other_id = payload(created)["id"]
    bound = client.post(f"/api/admin/managed-platform-accounts/{account_id}/bindings", headers=_bearer(admin), json={"userId": other_id})
    assert bound.status_code == 201
    logged_in = client.post("/api/user/auth/login", json={"username": "another-reporter", "password": "test-password"})
    other_token = payload(logged_in)["accessToken"]
    invalid = client.post("/api/user/browser-activity/v2", headers=_bearer(other_token), json=body(platform, account_id, consumed, ownerUserId=other_id))
    assert invalid.status_code == 403
    # An existing activity session cannot switch to another valid consumed identity.
    second_identity = _consume_bootstrap(client, user, platform, second, "a1b2c3d4")
    assert client.post("/api/user/browser-activity/v2", headers=_bearer(user), json=body(platform, account_id, consumed)).status_code == 200
    for bootstrap_id in (second_identity["sessionId"], None):
        response = client.post("/api/user/browser-activity/v2", headers=_bearer(user), json=body(
            platform, account_id, consumed, batchId=hashlib.sha256(str(bootstrap_id).encode()).hexdigest(), bootstrapSessionId=bootstrap_id,
        ))
        assert response.status_code == 403


def test_pre_upgrade_v2_receipt_digest_still_acknowledges_old_retry(launched: Any, api: Any) -> None:
    from app.db.models import BrowserActivityReceipt
    from app.schemas.browser_activity import BrowserActivityReportV2

    client, _admin, user, platform, account_id, consumed = launched
    _client, module = api
    old_body = body(platform, account_id, consumed)
    del old_body["bootstrapSessionId"]
    old_dump = BrowserActivityReportV2.model_validate(old_body).model_dump(mode="json", by_alias=True)
    old_dump.pop("bootstrapSessionId", None)
    old_digest = hashlib.sha256(json.dumps(old_dump, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    # Seed a durable acknowledgement as it existed before this optional field was added.
    with module.db.session() as session:
        session.add(BrowserActivityReceipt(user_id=1, batch_id=old_body["batchId"], payload_hash=old_digest, session_id=321))
    retried = client.post("/api/user/browser-activity/v2", headers=_bearer(user), json=old_body)
    assert retried.status_code == 200, retried.text
    assert payload(retried)["sessionId"] == 321
    assert payload(retried)["acknowledged"] is True


@pytest.mark.parametrize("value", ["0", "01", "-1", "9223372036854775808", 1, "abc"])
def test_bootstrap_identity_id_has_strict_string_shape(launched: Any, value: Any) -> None:
    client, _admin, user, platform, account_id, consumed = launched
    response = client.post("/api/user/browser-activity/v2", headers=_bearer(user), json=body(platform, account_id, consumed, bootstrapSessionId=value))
    assert response.status_code == 422
