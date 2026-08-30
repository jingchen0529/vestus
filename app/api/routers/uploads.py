"""Managed file uploads and the download endpoint.

``upload_file`` stays ``async`` because it consumes the multipart body from the
event loop; the two blocking steps -- writing the file and inserting its row --
are pushed to a threadpool.  If the insert fails for any reason the file on disk
is removed again, so a rolled-back request cannot leave an orphan behind.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

# Starlette's form parser produces ``starlette.datastructures.UploadFile``, not
# FastAPI's subclass, so the isinstance guard below has to name that class.
from starlette.datastructures import UploadFile

from app.api.deps import admin_auth, get_db
from app.api.responses import uploaded_file_response
from app.core.uploads import (
    EmptyUploadError,
    UploadTooLargeError,
    is_inline_safe,
    remove_stored_file,
    resolve_upload_path,
    store_upload,
)
from app.db.session import Database
from app.services import uploads as uploads_service

MISSING_FILE_DETAIL = "文件不存在"

router = APIRouter()


@router.post("/api/admin/uploads", status_code=201, tags=["uploads"])
async def upload_file(
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    async with request.form(max_files=1, max_fields=0) as form:
        files = form.getlist("file")
        if len(files) != 1 or not isinstance(files[0], UploadFile):
            raise HTTPException(status_code=422, detail="必须提供唯一的 file 文件字段")
        file = files[0]
        original_name = Path((file.filename or "file").replace("\\", "/")).name[:255] or "file"
        content_type = (
            file.content_type or "application/octet-stream"
        ).strip()[:255] or "application/octet-stream"
        try:
            stored = await run_in_threadpool(store_upload, file)
        except EmptyUploadError as exc:
            raise HTTPException(status_code=400, detail="上传文件不能为空") from exc
        except UploadTooLargeError as exc:
            raise HTTPException(status_code=413, detail="上传文件超过大小限制") from exc
        except OSError as exc:
            raise HTTPException(status_code=507, detail="文件存储空间不可用") from exc

    try:
        item = await run_in_threadpool(
            uploads_service.create_uploaded_file,
            db,
            original_name=original_name,
            path=stored.relative_path,
            content_type=content_type,
            size=stored.size,
            uploaded_by=auth["id"],
        )
    except Exception:
        await run_in_threadpool(remove_stored_file, stored.relative_path)
        raise
    return uploaded_file_response(request, item)


@router.get("/uploads/{file_path:path}", tags=["uploads"])
def uploaded_file(file_path: str, db: Database = Depends(get_db)) -> Response:
    relative_path = f"/uploads/{file_path}"
    item = uploads_service.get_uploaded_file_by_path(db, relative_path)
    if item is None:
        raise HTTPException(status_code=404, detail=MISSING_FILE_DETAIL)
    try:
        absolute_path = resolve_upload_path(relative_path)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=MISSING_FILE_DETAIL) from exc
    if not absolute_path.is_file():
        raise HTTPException(status_code=404, detail=MISSING_FILE_DETAIL)
    # An upload that is not provably a safe inline type is forced to download, so
    # a stored HTML or SVG payload cannot execute in the console's origin.
    disposition = "inline" if is_inline_safe(relative_path, item["contentType"]) else "attachment"
    return FileResponse(
        absolute_path,
        media_type=item["contentType"],
        filename=item["name"],
        content_disposition_type=disposition,
    )


__all__ = ["router"]
