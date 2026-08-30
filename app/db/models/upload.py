"""Metadata for files stored under the managed upload root."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class UploadedFile(Base):
    __tablename__ = "uploaded_file"
    __table_args__ = ({**TABLE_ARGS},)

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Always the ``/uploads/YYYY/MM/<uuid>.<ext>`` relative form -- never an
    #: absolute server path, protocol or hostname.
    path: Mapped[str] = mapped_column(String(512), nullable=False, unique=True, index=True)
    content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploaded_by: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now, index=True)
