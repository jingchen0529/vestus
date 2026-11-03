"""Widen user_log.target_type; managed table names exceed 16 chars

Revision ID: 0014
Revises: 0013
"""

from alembic import op
import sqlalchemy as sa


revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("user_log") as batch:
        batch.alter_column(
            "target_type",
            existing_type=sa.String(length=16),
            type_=sa.String(length=64),
            existing_nullable=True,
        )


def downgrade() -> None:
    with op.batch_alter_table("user_log") as batch:
        batch.alter_column(
            "target_type",
            existing_type=sa.String(length=64),
            type_=sa.String(length=16),
            existing_nullable=True,
        )
