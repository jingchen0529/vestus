import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from tests.envelope import payload


def test_storage_path_is_relative_and_cannot_escape_upload_root(
    api, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _client, _module = api
    monkeypatch.setenv("VESTUS_UPLOAD_DIR", str(tmp_path / "uploads"))
    from app.core.uploads import resolve_upload_path

    resolved = resolve_upload_path("/uploads/2026/08/example.bin")
    assert resolved == tmp_path / "uploads" / "2026" / "08" / "example.bin"
    with pytest.raises(ValueError):
        resolve_upload_path("/uploads/../../app.py")


def test_uploaded_file_repository_stores_only_relative_path(api) -> None:
    _client, module = api
    from app.db.models import UploadedFile

    item = module.db.create_uploaded_file(
        original_name="report.pdf",
        path="/uploads/2026/08/example.pdf",
        content_type="application/pdf",
        size=12,
        uploaded_by=1,
    )
    assert item["path"] == "/uploads/2026/08/example.pdf"
    assert "://" not in item["path"]
    with module.db.session() as session:
        stored = session.scalar(select(UploadedFile))
        assert stored is not None
        assert stored.path == "/uploads/2026/08/example.pdf"


def test_repository_accepts_only_registered_inline_image_references(api) -> None:
    _client, module = api
    safe_path = f"/uploads/2026/08/{'a' * 32}.png"
    unsafe_path = f"/uploads/2026/08/{'b' * 32}.png"
    missing_path = f"/uploads/2026/08/{'c' * 32}.png"
    module.db.create_uploaded_file(
        original_name="safe.png",
        path=safe_path,
        content_type="image/png",
        size=4,
        uploaded_by=1,
    )
    module.db.create_uploaded_file(
        original_name="unsafe.png",
        path=unsafe_path,
        content_type="text/html",
        size=4,
        uploaded_by=1,
    )

    branding = module.db.set_branding(logo_url=safe_path, admin_logo_url=safe_path)
    assert branding["logoUrl"] == safe_path
    assert branding["adminLogoUrl"] == safe_path
    platform = module.db.insert_platform(
        {"name": "Safe icon", "url": "https://safe.example.test", "icon_url": safe_path}
    )
    assert platform["iconUrl"] == safe_path

    for invalid_path in (
        "https://cdn.example.test/logo.png",
        "data:image/png;base64,AAAA",
        "/uploads/2026/08/not-generated.png",
        missing_path,
        unsafe_path,
    ):
        with pytest.raises(ValueError):
            module.db.set_branding(logo_url=invalid_path)
        with pytest.raises(ValueError):
            module.db.update_platform(platform["id"], {"icon_url": invalid_path})

    with pytest.raises(ValueError):
        module.db.set_branding(admin_logo_url=missing_path)
    assert module.db.get_branding()["logoUrl"] == safe_path
    assert module.db.get_platform(platform["id"])["iconUrl"] == safe_path

    assert module.db.set_branding(logo_url="", admin_logo_url="")["logoUrl"] == ""
    assert module.db.update_platform(platform["id"], {"icon_url": ""})["iconUrl"] == ""


def test_legacy_invalid_image_references_are_serialized_as_empty(api) -> None:
    _client, module = api
    unsafe_path = f"/uploads/2026/08/{'d' * 32}.png"
    module.db.create_uploaded_file(
        original_name="unsafe.png",
        path=unsafe_path,
        content_type="text/html",
        size=4,
        uploaded_by=1,
    )
    module.db.set_setting("product_logo", "data:image/png;base64,AAAA")
    module.db.set_setting("admin_logo", unsafe_path)
    with module.db.session() as session:
        session.add(
            module.Platform(
                name="Legacy icon",
                url="https://legacy.example.test",
                icon_url=unsafe_path,
                sort_order=0,
                status="active",
            )
        )

    branding = module.db.get_branding()
    assert branding["logoUrl"] == ""
    assert branding["adminLogoUrl"] == ""
    assert module.db.list_platforms()[0]["iconUrl"] == ""


def test_repository_accepts_standard_ico_mime_alias(api) -> None:
    _client, module = api
    from app.core.uploads import is_inline_safe

    icon_path = f"/uploads/2026/08/{'e' * 32}.ico"
    assert is_inline_safe(icon_path, "image/vnd.microsoft.icon") is True
    module.db.create_uploaded_file(
        original_name="favicon.ico",
        path=icon_path,
        content_type="image/vnd.microsoft.icon",
        size=4,
        uploaded_by=1,
    )

    branding = module.db.set_branding(admin_logo_url=icon_path)

    assert branding["adminLogoUrl"] == icon_path


def _login_admin(client):
    response = client.post(
        "/api/admin/auth/login",
        json={"username": "test-admin", "password": "test-admin-password"},
    )
    assert response.status_code == 200
    return payload(response)["accessToken"]


def test_only_admin_can_upload_and_response_uses_current_origin(api) -> None:
    client, module = api
    assert client.post(
        "/api/admin/uploads",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    ).status_code == 401

    token = _login_admin(client)
    response = client.post(
        "/api/admin/uploads",
        headers={"Authorization": f"Bearer {token}", "Host": "files.example.test"},
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 201, response.text
    body = payload(response)
    assert body["path"].startswith("/uploads/")
    assert body["url"] == f"http://files.example.test{body['path']}"
    assert body["name"] == "notes.txt"
    assert body["contentType"] == "text/plain"
    assert body["size"] == 5
    assert "://" not in module.db.get_uploaded_file_by_path(body["path"])["path"]


@pytest.mark.parametrize(
    ("origin", "expected_status"),
    [
        (None, 403),
        ("http://attacker.testserver", 403),
        ("http://testserver", 201),
    ],
    ids=["missing-origin", "same-site-cross-origin", "same-origin"],
)
def test_cookie_authenticated_upload_accepts_only_current_origin(
    api, tmp_path: Path, origin: str | None, expected_status: int
) -> None:
    client, _module = api
    _login_admin(client)
    headers = {"Origin": origin} if origin is not None else {}

    response = client.post(
        "/api/admin/uploads",
        headers=headers,
        files={"file": ("cookie-upload.txt", b"cookie-authenticated", "text/plain")},
    )

    assert response.status_code == expected_status, response.text
    if expected_status == 403:
        assert _files_under(tmp_path / "uploads") == []


def test_bearer_authenticated_upload_allows_cross_origin_request(api) -> None:
    client, _module = api
    token = _login_admin(client)

    response = client.post(
        "/api/admin/uploads",
        headers={
            "Authorization": f"Bearer {token}",
            "Origin": "http://attacker.testserver",
        },
        files={"file": ("bearer-upload.txt", b"bearer-authenticated", "text/plain")},
    )

    assert response.status_code == 201, response.text


def test_cookie_authenticated_safe_admin_request_does_not_require_origin(api) -> None:
    client, _module = api
    _login_admin(client)

    response = client.get("/api/admin/auth/me")

    assert response.status_code == 200, response.text


def test_cookie_authenticated_admin_write_policy_is_not_upload_specific(api) -> None:
    client, _module = api
    _login_admin(client)

    response = client.put(
        "/api/admin/settings",
        headers={"Origin": "http://attacker.testserver"},
        json={"productName": "must-not-be-written"},
    )

    assert response.status_code == 403, response.text
    assert payload(client.get("/api/product"))["productName"] != "must-not-be-written"


def test_unauthenticated_malformed_multipart_is_rejected_before_parsing(api) -> None:
    client, _module = api
    response = client.post(
        "/api/admin/uploads",
        content=b"--missing-boundary",
        headers={"Content-Type": "multipart/form-data"},
    )

    assert response.status_code == 401


def test_chunked_upload_body_without_content_length_is_limited_before_parsing(
    api, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    token = _login_admin(client)
    monkeypatch.setenv("VESTUS_UPLOAD_MAX_BYTES", "4")
    boundary = b"vestus-boundary"
    prefix = (
        b"--" + boundary
        + b'\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\n'
        + b"Content-Type: application/octet-stream\r\n\r\n"
    )
    body = prefix + (b"x" * (64 * 1024 + 16))
    chunks = [body[:32_768], body[32_768:65_536], body[65_536:], b"not-consumed"]
    receive_messages = [
        {"type": "http.request", "body": chunk, "more_body": index < len(chunks) - 1}
        for index, chunk in enumerate(chunks)
    ]
    sent_messages = []

    async def invoke() -> int:
        consumed = 0

        async def receive():
            nonlocal consumed
            if not receive_messages:
                return {"type": "http.disconnect"}
            consumed += 1
            return receive_messages.pop(0)

        async def send(message):
            sent_messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/admin/uploads",
            "raw_path": b"/api/admin/uploads",
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"authorization", f"Bearer {token}".encode("ascii")),
                (b"content-type", b"multipart/form-data; boundary=" + boundary),
            ],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
        }
        await module.app(scope, receive, send)
        return consumed

    consumed = asyncio.run(invoke())
    response_start = next(message for message in sent_messages if message["type"] == "http.response.start")

    assert response_start["status"] == 413
    assert consumed < len(chunks)


@pytest.mark.parametrize(
    "scope_path",
    ["/vestus/api/admin/uploads", "/api/admin/uploads"],
    ids=["path-includes-root-path", "path-already-stripped"],
)
def test_upload_body_limit_honors_root_path(
    monkeypatch: pytest.MonkeyPatch, scope_path: str
) -> None:
    from app.core.middleware import UploadBodyLimitMiddleware

    monkeypatch.setenv("VESTUS_UPLOAD_MAX_BYTES", "4")
    body = b"x" * 70_000
    receive_messages = [
        {"type": "http.request", "body": body[:35_000], "more_body": True},
        {"type": "http.request", "body": body[35_000:], "more_body": False},
    ]
    sent_messages = []
    downstream_bytes = 0

    async def downstream(_scope, receive, send) -> None:
        nonlocal downstream_bytes
        while True:
            message = await receive()
            downstream_bytes += len(message.get("body", b""))
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def invoke() -> None:
        async def receive():
            return receive_messages.pop(0)

        async def send(message):
            sent_messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": scope_path,
            "raw_path": scope_path.encode("ascii"),
            "query_string": b"",
            "root_path": "/vestus",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
        }
        await UploadBodyLimitMiddleware(downstream)(scope, receive, send)

    asyncio.run(invoke())
    response_start = next(message for message in sent_messages if message["type"] == "http.response.start")

    assert response_start["status"] == 413
    assert downstream_bytes < len(body)


def test_upload_requires_exactly_one_file_and_no_extra_fields(api) -> None:
    client, _module = api
    token = _login_admin(client)
    headers = {"Authorization": f"Bearer {token}"}

    missing = client.post(
        "/api/admin/uploads",
        headers=headers,
        files={"other": ("notes.txt", b"hello", "text/plain")},
    )
    non_file = client.post(
        "/api/admin/uploads",
        headers=headers,
        data={"file": "not-a-file"},
    )
    duplicate = client.post(
        "/api/admin/uploads",
        headers=headers,
        files=[
            ("file", ("one.txt", b"one", "text/plain")),
            ("file", ("two.txt", b"two", "text/plain")),
        ],
    )
    extra_field = client.post(
        "/api/admin/uploads",
        headers=headers,
        data={"description": "not allowed"},
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )

    assert missing.status_code == 422
    assert non_file.status_code == 422
    assert duplicate.status_code == 400
    assert extra_field.status_code == 400


def test_uploaded_files_are_public_and_dangerous_types_download_as_attachment(api) -> None:
    client, _module = api
    token = _login_admin(client)
    headers = {"Authorization": f"Bearer {token}"}
    html = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("page.html", b"<script>alert(1)</script>", "text/html")},
        )
    )
    mismatch = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("looks-safe.png", b"<script>alert(2)</script>", "text/html")},
        )
    )
    client.cookies.clear()
    download = client.get(html["path"])
    assert download.status_code == 200
    assert download.content == b"<script>alert(1)</script>"
    assert download.headers["content-type"].startswith("text/html")
    assert download.headers["content-disposition"].startswith("attachment")
    mismatched_download = client.get(mismatch["path"])
    assert mismatched_download.status_code == 200
    assert mismatched_download.headers["content-disposition"].startswith("attachment")

    token = _login_admin(client)
    headers = {"Authorization": f"Bearer {token}"}
    image = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("logo.png", b"not-executable", "image/png")},
        )
    )
    client.cookies.clear()
    inline = client.get(image["path"])
    assert inline.status_code == 200
    assert inline.headers["content-disposition"].startswith("inline")


def _files_under(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file()]


def test_empty_and_oversized_uploads_are_rejected_and_cleaned(
    api, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _module = api
    token = _login_admin(client)
    headers = {"Authorization": f"Bearer {token}"}
    empty = client.post(
        "/api/admin/uploads",
        headers=headers,
        files={"file": ("empty.bin", b"", "application/octet-stream")},
    )
    assert empty.status_code == 400
    monkeypatch.setenv("VESTUS_UPLOAD_MAX_BYTES", "4")
    oversized = client.post(
        "/api/admin/uploads",
        headers=headers,
        files={"file": ("large.bin", b"12345", "application/octet-stream")},
    )
    assert oversized.status_code == 413
    assert _files_under(tmp_path / "uploads") == []


def test_database_failure_removes_stored_file(
    api, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    token = _login_admin(client)

    def fail_create(*_args, **_values):
        raise module.SQLAlchemyError("database unavailable")

    monkeypatch.setattr(module.services.uploads, "create_uploaded_file", fail_create)
    response = client.post(
        "/api/admin/uploads",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("orphan.bin", b"data", "application/octet-stream")},
    )
    assert response.status_code == 503
    assert _files_under(tmp_path / "uploads") == []


def test_unknown_upload_path_returns_not_found(api) -> None:
    client, _module = api
    assert client.get("/uploads/2026/08/missing.bin").status_code == 404


def test_public_upload_route_rejects_symlinked_file(api, tmp_path: Path) -> None:
    client, _module = api
    token = _login_admin(client)
    uploaded = payload(
        client.post(
            "/api/admin/uploads",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("report.txt", b"uploaded", "text/plain")},
        )
    )
    upload_root = tmp_path / "uploads"
    target = upload_root / "other-file.txt"
    target.write_bytes(b"not the uploaded file")
    stored_path = upload_root / uploaded["path"].removeprefix("/uploads/")
    stored_path.unlink()
    stored_path.symlink_to(target)

    response = client.get(uploaded["path"])
    assert response.status_code == 404


def test_public_upload_route_rejects_regular_file_in_path(api, tmp_path: Path) -> None:
    client, module = api
    token = _login_admin(client)
    uploaded = payload(
        client.post(
            "/api/admin/uploads",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("report.txt", b"uploaded", "text/plain")},
        )
    )
    stored_path = tmp_path / "uploads" / uploaded["path"].removeprefix("/uploads/")
    month_directory = stored_path.parent
    stored_path.unlink()
    month_directory.rmdir()
    month_directory.write_bytes(b"not a directory")
    try:
        with TestClient(module.app, raise_server_exceptions=False) as public_client:
            response = public_client.get(uploaded["path"])
        assert response.status_code == 404
    finally:
        month_directory.unlink()
        month_directory.mkdir()
        stored_path.write_bytes(b"uploaded")
