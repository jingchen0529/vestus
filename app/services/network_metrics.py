from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db.base import parse_datetime, utc_now
from app.db.models import NetworkMetric, User
from app.db.session import Database
from app.repositories import network_metrics as repo
from app.schemas.network_metric import NetworkDiagnosticsReport
from app.services.errors import ConflictError


def _payload_hash(report: NetworkDiagnosticsReport) -> str:
    return hashlib.sha256(
        json.dumps(report.model_dump(mode="json", by_alias=True), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _same(existing: NetworkMetric, sample: Any, device_id: str) -> bool:
    values = {
        "sample_id": sample.sample_id,
        "user_id": existing.user_id,
        "device_id": device_id,
        "route": sample.route,
        "target_kind": sample.target_kind,
        "network_mode": sample.network_mode,
        "platform_id": sample.platform_id,
        "browser_id": sample.browser_id,
        "started_at_ms": sample.started_at_ms,
        "duration_ms": sample.duration_ms,
        "connect_ms": sample.connect_ms,
        "ttfb_ms": sample.ttfb_ms,
        "total_ms": sample.total_ms,
        "response_bytes": sample.response_bytes,
        "download_kbps": sample.download_kbps,
        "status": sample.status,
        "error_code": sample.error_code,
        "client_version": sample.client_version,
    }
    return all(getattr(existing, key) == value for key, value in values.items())


def record_report(
    database: Database, report: NetworkDiagnosticsReport, *, user_id: int, device_id: Optional[str] = None
) -> dict[str, Any]:
    accepted = 0
    duplicate = 0
    now = utc_now()
    device_id = report.device_id or device_id or "unknown"
    with database.session() as session:
        session.execute(select(User.id).where(User.id == user_id).with_for_update()).first()
        for sample in report.samples:
            existing = repo.find_sample(session, sample.sample_id, user_id)
            if existing is not None:
                if _same(existing, sample, device_id):
                    duplicate += 1
                    continue
                raise ConflictError("sampleId 已存在但内容不一致")
            measured_at = now
            if sample.started_at_ms:
                try:
                    candidate = datetime.fromtimestamp(sample.started_at_ms / 1000, timezone.utc).replace(tzinfo=None)
                    if now - timedelta(days=31) <= candidate <= now + timedelta(minutes=5):
                        measured_at = candidate
                except (OverflowError, OSError, ValueError):
                    pass
            item = NetworkMetric(
                sample_id=sample.sample_id,
                user_id=user_id,
                device_id=device_id,
                route=sample.route,
                target_kind=sample.target_kind,
                network_mode=sample.network_mode,
                platform_id=sample.platform_id,
                browser_id=sample.browser_id,
                measured_at=measured_at,
                received_at=now,
                started_at_ms=sample.started_at_ms,
                duration_ms=sample.duration_ms,
                connect_ms=sample.connect_ms,
                ttfb_ms=sample.ttfb_ms,
                total_ms=sample.total_ms,
                response_bytes=sample.response_bytes,
                download_kbps=sample.download_kbps,
                status=sample.status,
                error_code=sample.error_code,
                client_version=sample.client_version,
            )
            session.add(item)
            accepted += 1
        try:
            session.flush()
        except IntegrityError:
            raise ConflictError("sampleId 已存在但内容不一致") from None
        try:
            with session.begin_nested():
                repo.delete_expired(session, now - timedelta(days=31))
        except Exception:
            # Retention is best effort. The outer transaction still commits the report.
            pass
    return {"accepted": accepted, "duplicate": duplicate, "protocolVersion": report.protocol_version}


def _nearest(values: list[int], percentile: float) -> Optional[int]:
    if not values:
        return None
    values.sort()
    return values[max(0, math.ceil(percentile * len(values)) - 1)]


def list_metrics(
    database: Database,
    *,
    page: int = 1,
    page_size: int = 50,
    user_id: Optional[int] = None,
    device_id: Optional[str] = None,
    route: Optional[str] = None,
    network_mode: Optional[str] = None,
    status: Optional[str] = None,
    start_at: Any = None,
    end_at: Any = None,
    visible_admin_id: Optional[int] = None,
) -> dict[str, Any]:
    page, page_size = max(1, int(page)), min(200, max(1, int(page_size)))
    start = parse_datetime(start_at) if start_at else now_minus_day()
    end = parse_datetime(end_at, end_of_day=True) if end_at else utc_now()
    with database.session() as session:
        ids = repo.visible_user_ids(session, visible_admin_id)
        rows, total = repo.query(
            session,
            user_ids=ids,
            user_id=user_id,
            device_id=device_id,
            route=route,
            network_mode=network_mode,
            status=status,
            start_at=start,
            end_at=end,
            page=page,
            page_size=page_size,
        )
        all_rows = repo.summary_values(
            session,
            user_ids=ids,
            user_id=user_id,
            device_id=device_id,
            route=route,
            network_mode=network_mode,
            status=status,
            start_at=start,
            end_at=end,
        )
    times = [int(row.total_ms) for row in all_rows if row.total_ms is not None]
    failures = sum(1 for row in all_rows if row.status == "error")
    items = [
        {
            "sampleId": r.sample_id,
            "userId": r.user_id,
            "deviceId": r.device_id,
            "route": r.route,
            "targetKind": r.target_kind,
            "networkMode": r.network_mode,
            "platformId": r.platform_id,
            "browserId": r.browser_id,
            "measuredAt": r.measured_at.isoformat() + "Z",
            "receivedAt": r.received_at.isoformat() + "Z",
            "startedAtMs": r.started_at_ms,
            "durationMs": r.duration_ms,
            "connectMs": r.connect_ms,
            "ttfbMs": r.ttfb_ms,
            "totalMs": r.total_ms,
            "responseBytes": r.response_bytes,
            "downloadKbps": r.download_kbps,
            "status": r.status,
            "errorCode": r.error_code,
            "clientVersion": r.client_version,
        }
        for r in rows
    ]
    p50, p95 = _nearest(times, 0.5), _nearest(times, 0.95)
    return {
        "items": items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "pages": math.ceil(total / page_size) if total else 0,
        "summary": {
            "p50": p50,
            "p95": p95,
            "p50Ms": p50,
            "p95Ms": p95,
            "failureRate": (failures / total if total else 0),
            "count": total,
        },
    }


def now_minus_day() -> datetime:
    return utc_now() - timedelta(days=1)


record_network_diagnostics = record_report
list_network_metrics = list_metrics
