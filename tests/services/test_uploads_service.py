"""Service-layer tests for ``app.services.uploads``.

Pins the two rules that make upload references safe to serve inline: the
stored path must live under ``/uploads/``, and an image reference must match
the managed pattern and resolve to a stored upload whose extension and content
type agree.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from app.db.session import Database
from app.services import uploads as uploads_service
from app.services.errors import BadRequestError

#: 符合 UPLOAD_REFERENCE_PATTERN:``/uploads/YYYY/MM/<32 hex>.<ext>``。
PNG_PATH = f"/uploads/2026/08/{'a' * 32}.png"
FAKE_PATH = f"/uploads/2026/08/{'b' * 32}.png"
MISSING_PATH = f"/uploads/2026/08/{'c' * 32}.png"


def _create(
    service_db: Database, *, path: str = PNG_PATH, content_type: str = "image/png"
) -> Dict[str, Any]:
    return uploads_service.create_uploaded_file(
        service_db,
        original_name=path.rsplit("/", 1)[-1],
        path=path,
        content_type=content_type,
        size=10,
        uploaded_by=1,
    )


def test_path_must_live_under_the_upload_prefix(service_db: Database) -> None:
    with pytest.raises(BadRequestError):
        _create(service_db, path="/etc/passwd")
    with pytest.raises(BadRequestError):
        _create(service_db, path="/uploads/http://evil.test/x.png")

    assert uploads_service.get_uploaded_file_by_path(service_db, "/etc/passwd") is None


def test_create_and_lookup_roundtrip(service_db: Database) -> None:
    created = _create(service_db)

    found = uploads_service.get_uploaded_file_by_path(service_db, created["path"])

    assert found is not None and found["path"] == PNG_PATH
    assert uploads_service.get_uploaded_file_by_path(service_db, MISSING_PATH) is None


def test_image_reference_requires_an_inline_safe_upload(service_db: Database) -> None:
    _create(service_db)  # png + image/png:合格
    _create(service_db, path=FAKE_PATH, content_type="text/html")  # 扩展名与类型不符

    with service_db.session() as session:
        normalized, row = uploads_service.validated_image_reference(session, PNG_PATH)
        assert normalized == PNG_PATH and row is not None

        with pytest.raises(BadRequestError):
            uploads_service.validated_image_reference(session, FAKE_PATH)
        with pytest.raises(BadRequestError):
            uploads_service.validated_image_reference(session, MISSING_PATH)
        # 不符合托管路径模式的自由形态引用直接拒绝,不落到存储查询。
        with pytest.raises(BadRequestError):
            uploads_service.validated_image_reference(session, "/uploads/ok.png")


def test_empty_reference_clears_instead_of_failing(service_db: Database) -> None:
    with service_db.session() as session:
        assert uploads_service.validated_image_reference(session, "") == ("", None)
        assert uploads_service.validated_image_reference(session, None) == ("", None)
