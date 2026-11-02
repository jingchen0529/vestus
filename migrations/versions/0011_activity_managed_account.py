"""record the managed account used by browser activity sessions

Revision ID: 0011
Revises: 0010
"""

from alembic import op
import sqlalchemy as sa


revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

IdType = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    with op.batch_alter_table("browser_session") as batch:
        batch.add_column(sa.Column("managed_account_id", IdType, nullable=True))
        batch.add_column(sa.Column("managed_account_name", sa.String(length=255), nullable=True))
        batch.create_index("ix_browser_session_managed_account_id", ["managed_account_id"])


def downgrade() -> None:
    with op.batch_alter_table("browser_session") as batch:
        batch.drop_index("ix_browser_session_managed_account_id")
        batch.drop_column("managed_account_name")
        batch.drop_column("managed_account_id")
