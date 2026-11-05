"""Require automatic recovery for password-managed accounts.

Revision ID: 0017
Revises: 0016
"""

from alembic import op
import sqlalchemy as sa

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Data-only SQL deliberately avoids ORM onupdate hooks and recovery queuing:
    # credentials, versions, statuses, attempts, leases and timestamps stay intact.
    op.execute(sa.text(
        "UPDATE managed_platform_account "
        "SET auto_relogin = 1 "
        "WHERE auth_mode = 'server_login' AND auto_relogin = 0"
    ))


def downgrade() -> None:
    # The old opt-outs cannot be distinguished from previously enabled accounts.
    # Irreversible normalization: keep recovery enabled rather than disable
    # existing password recovery or disturb its durable jobs on rollback.
    pass
