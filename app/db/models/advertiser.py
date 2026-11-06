"""An advertiser found in one immutable recorded page address."""
from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, IdType


class BrowserPageAdvertiser(Base):
    __tablename__ = "browser_page_advertiser"
    __table_args__ = {**TABLE_ARGS}

    page_id: Mapped[int] = mapped_column(
        IdType, ForeignKey("browser_page_visit.id", ondelete="CASCADE"), primary_key=True, autoincrement=False,
    )
    advertiser_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
