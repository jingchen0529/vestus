"""Managed upload storage: path safety, streaming writes, inline-safety rules.

The upload root and the per-file size limit come from :mod:`app.core.config`
and are re-read on every call, so an operator can change
``VESTUS_UPLOAD_DIR`` / ``VESTUS_UPLOAD_MAX_BYTES`` without a restart.
"""

from __future__ import annotations

import os
import re
import stat
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# The Starlette base class, not FastAPI's subclass: the form parser hands us the
# base class, and only ``.filename`` / ``.file`` are needed here.
from starlette.datastructures import UploadFile

from app.core.config import DEFAULT_MAX_UPLOAD_BYTES, get_settings

UPLOAD_URL_PREFIX = "/uploads/"
CHUNK_SIZE = 64 * 1024
UPLOAD_REFERENCE_PATTERN = re.compile(
    r"^/uploads/[0-9]{4}/(?:0[1-9]|1[0-2])/[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$"
)


@dataclass(frozen=True)
class StoredFile:
    relative_path: str
    absolute_path: Path
    size: int


class EmptyUploadError(ValueError):
    pass


class UploadTooLargeError(ValueError):
    pass


def normalize_upload_reference(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""
    if UPLOAD_REFERENCE_PATTERN.fullmatch(normalized) is None:
        raise ValueError("invalid managed upload reference")
    return normalized

def upload_root() -> Path:
    return get_settings().upload_root


def upload_max_bytes() -> int:
    return get_settings().upload_max_bytes


def resolve_upload_path(relative_path: str) -> Path:
    if not relative_path.startswith(UPLOAD_URL_PREFIX) or "\\" in relative_path:
        raise ValueError("invalid upload path")
    parts = Path(relative_path[len(UPLOAD_URL_PREFIX):]).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ValueError("invalid upload path")
    root = upload_root()
    candidate = root
    for part in parts:
        candidate = candidate / part
        try:
            mode = candidate.lstat().st_mode
        except FileNotFoundError:
            continue
        except NotADirectoryError as exc:
            raise ValueError("invalid upload path") from exc
        if stat.S_ISLNK(mode):
            raise ValueError("invalid upload path")
    resolved = candidate.resolve()
    if root not in resolved.parents:
        raise ValueError("invalid upload path")
    return resolved


def store_upload(upload: UploadFile) -> StoredFile:
    original_suffix = Path(upload.filename or "").suffix.lower()
    suffix = original_suffix if re.fullmatch(r"\.[a-z0-9]{1,16}", original_suffix) else ""
    now = datetime.now(timezone.utc)
    relative_path = f"{UPLOAD_URL_PREFIX}{now:%Y/%m}/{uuid.uuid4().hex}{suffix}"
    destination = resolve_upload_path(relative_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".upload-", suffix=".tmp", dir=destination.parent)
    temporary_path = Path(temporary_name)
    size = 0
    try:
        with os.fdopen(descriptor, "wb") as target:
            while chunk := upload.file.read(CHUNK_SIZE):
                size += len(chunk)
                if size > upload_max_bytes():
                    raise UploadTooLargeError
                target.write(chunk)
        if size == 0:
            raise EmptyUploadError
        os.replace(temporary_path, destination)
        return StoredFile(relative_path, destination, size)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        raise


def remove_stored_file(relative_path: str) -> None:
    resolve_upload_path(relative_path).unlink(missing_ok=True)


def is_inline_safe(relative_path: str, content_type: str) -> bool:
    allowed = {
        ".png": {"image/png"},
        ".jpg": {"image/jpeg"},
        ".jpeg": {"image/jpeg"},
        ".gif": {"image/gif"},
        ".webp": {"image/webp"},
        ".ico": {"image/x-icon", "image/vnd.microsoft.icon"},
    }
    return content_type.lower() in allowed.get(Path(relative_path).suffix.lower(), set())


__all__ = [
    "CHUNK_SIZE",
    "DEFAULT_MAX_UPLOAD_BYTES",
    "EmptyUploadError",
    "StoredFile",
    "UPLOAD_REFERENCE_PATTERN",
    "UPLOAD_URL_PREFIX",
    "UploadTooLargeError",
    "is_inline_safe",
    "normalize_upload_reference",
    "remove_stored_file",
    "resolve_upload_path",
    "store_upload",
    "upload_max_bytes",
    "upload_root",
]
