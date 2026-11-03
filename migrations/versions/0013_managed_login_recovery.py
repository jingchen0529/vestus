"""Persist managed login recovery state and cross-worker leases.

Revision ID: 0013
Revises: 0012
"""

from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("managed_platform_account") as batch:
        batch.add_column(sa.Column("auto_relogin", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("recovery_status", sa.String(16), nullable=False, server_default="idle"))
        batch.add_column(sa.Column("recovery_attempts", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("next_recovery_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("recovery_lease_token", sa.String(64), nullable=True))
        batch.add_column(sa.Column("recovery_lease_until", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("last_recovered_at", sa.DateTime(), nullable=True))
        batch.create_index("ix_managed_platform_account_recovery_status", ["recovery_status"])
        batch.create_index("ix_managed_platform_account_next_recovery_at", ["next_recovery_at"])
    # Existing password-managed accounts opt into the same maintenance as new ones.
    op.execute(sa.text("UPDATE managed_platform_account SET auto_relogin = 1 WHERE auth_mode = 'server_login'"))


def downgrade() -> None:
    with op.batch_alter_table("managed_platform_account") as batch:
        batch.drop_index("ix_managed_platform_account_next_recovery_at")
        batch.drop_index("ix_managed_platform_account_recovery_status")
        for column in (
            "last_recovered_at", "recovery_lease_until", "recovery_lease_token",
            "next_recovery_at", "recovery_attempts", "recovery_status", "auto_relogin",
        ):
            batch.drop_column(column)
