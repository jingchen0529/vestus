"""store administrator managed credentials in plaintext

Revision ID: 0009
Revises: 0008
"""

from alembic import op
import sqlalchemy as sa


revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("managed_platform_account", sa.Column("username", sa.Text(), nullable=True))
    op.add_column("managed_platform_account", sa.Column("password", sa.Text(), nullable=True))
    op.add_column("managed_platform_account", sa.Column("cookie_bundle", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("managed_platform_account", "cookie_bundle")
    op.drop_column("managed_platform_account", "password")
    op.drop_column("managed_platform_account", "username")
