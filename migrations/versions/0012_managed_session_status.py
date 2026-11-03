"""track whether a managed account's upstream session is still usable

Revision ID: 0012
Revises: 0011
"""

from alembic import op
import sqlalchemy as sa


revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("managed_platform_account") as batch:
        batch.add_column(
            sa.Column("session_status", sa.String(length=16), nullable=False,
                      server_default="valid")
        )


def downgrade() -> None:
    with op.batch_alter_table("managed_platform_account") as batch:
        batch.drop_column("session_status")
