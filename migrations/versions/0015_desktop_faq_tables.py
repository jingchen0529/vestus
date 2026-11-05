"""desktop FAQ groups and Q&A items

Revision ID: 0015
Revises: 0014
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

DateTime6 = mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), "sqlite")
IdType = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "desktop_faq_group",
        sa.Column("id", IdType, primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", DateTime6, nullable=False),
        sa.Column("updated_at", DateTime6, nullable=False),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_desktop_faq_group_sort_order", "desktop_faq_group", ["sort_order"])
    op.create_index("ix_desktop_faq_group_status", "desktop_faq_group", ["status"])

    op.create_table(
        "desktop_faq_item",
        sa.Column("id", IdType, primary_key=True, autoincrement=True),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("question", sa.String(length=255), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", DateTime6, nullable=False),
        sa.Column("updated_at", DateTime6, nullable=False),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_desktop_faq_item_group_id", "desktop_faq_item", ["group_id"])
    op.create_index("ix_desktop_faq_item_sort_order", "desktop_faq_item", ["sort_order"])
    op.create_index("ix_desktop_faq_item_status", "desktop_faq_item", ["status"])


def downgrade() -> None:
    op.drop_table("desktop_faq_item")
    op.drop_table("desktop_faq_group")
