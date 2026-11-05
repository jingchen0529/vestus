"""Persist the latest managed identity-check attempt separately from success.

Revision ID: 0016
Revises: 0015
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

DateTime6 = mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), "sqlite")


def upgrade() -> None:
    with op.batch_alter_table("managed_platform_account") as batch:
        batch.add_column(sa.Column("last_identity_check_state", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("last_identity_check_at", DateTime6, nullable=True))
        batch.add_column(sa.Column("last_identity_check_detail", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("managed_platform_account") as batch:
        batch.drop_column("last_identity_check_detail")
        batch.drop_column("last_identity_check_at")
        batch.drop_column("last_identity_check_state")
