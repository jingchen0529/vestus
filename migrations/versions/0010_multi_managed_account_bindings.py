"""allow multiple managed accounts per user and store verified identity metadata

Revision ID: 0010
Revises: 0009
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

DateTime6 = mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), "sqlite")


def upgrade() -> None:
    with op.batch_alter_table("managed_platform_account") as batch:
        batch.add_column(sa.Column("remote_account_id", sa.String(length=128), nullable=True))
        batch.add_column(sa.Column("remote_display_name", sa.String(length=255), nullable=True))
        batch.add_column(sa.Column("identity_checked_at", DateTime6, nullable=True))
        batch.create_index(
            "ix_managed_platform_account_remote_account_id",
            ["remote_account_id"],
        )
        batch.create_index(
            "ix_managed_platform_account_identity_checked_at",
            ["identity_checked_at"],
        )

    with op.batch_alter_table("managed_platform_binding") as batch:
        batch.drop_constraint("uq_managed_binding_user_platform", type_="unique")
        batch.create_unique_constraint(
            "uq_managed_binding_user_platform_account",
            ["user_id", "platform_id", "managed_account_id"],
        )


def downgrade() -> None:
    duplicate = op.get_bind().execute(
        sa.text(
            "SELECT user_id, platform_id FROM managed_platform_binding "
            "GROUP BY user_id, platform_id HAVING COUNT(*) > 1 LIMIT 1"
        )
    ).first()
    if duplicate is not None:
        raise RuntimeError(
            "cannot downgrade multi-account bindings while distinct bindings exist"
        )
    with op.batch_alter_table("managed_platform_binding") as batch:
        batch.drop_constraint("uq_managed_binding_user_platform_account", type_="unique")
        batch.create_unique_constraint(
            "uq_managed_binding_user_platform",
            ["user_id", "platform_id"],
        )

    with op.batch_alter_table("managed_platform_account") as batch:
        batch.drop_index("ix_managed_platform_account_identity_checked_at")
        batch.drop_index("ix_managed_platform_account_remote_account_id")
        batch.drop_column("identity_checked_at")
        batch.drop_column("remote_display_name")
        batch.drop_column("remote_account_id")
