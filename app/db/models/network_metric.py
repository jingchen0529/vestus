from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class NetworkMetric(Base):
    __tablename__ = "desktop_network_metric"
    __table_args__ = (
        UniqueConstraint("user_id", "sample_id", name="uq_desktop_network_metric_user_sample"),
        Index("ix_network_metric_user_measured", "user_id", "measured_at"),
        Index("ix_network_metric_device", "device_id"),
        Index("ix_network_metric_route_mode", "route", "network_mode"),
        Index("ix_network_metric_received_at", "received_at"),
        {**TABLE_ARGS},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    sample_id: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[int] = mapped_column(IdType, ForeignKey("user.id"), nullable=False)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    route: Mapped[str] = mapped_column(String(16), nullable=False)
    target_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    network_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    platform_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    browser_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    measured_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    started_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    duration_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    connect_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    ttfb_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    total_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    response_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    download_kbps: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error_code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    client_version: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

