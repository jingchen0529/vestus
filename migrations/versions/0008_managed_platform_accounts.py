"""managed platform credentials and one-time bootstrap grants

Revision ID: 0008
Revises: 0007
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

DateTime6 = mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), "sqlite")
IdType = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "managed_platform_account",
        sa.Column("id", IdType, primary_key=True, autoincrement=True),
        sa.Column("platform_id", IdType, nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("auth_mode", sa.String(length=24), nullable=False),
        sa.Column("encrypted_username", sa.LargeBinary(), nullable=True),
        sa.Column("encrypted_password", sa.LargeBinary(), nullable=True),
        sa.Column("encrypted_cookie_bundle", sa.LargeBinary(), nullable=True),
        sa.Column("allowed_hosts", sa.JSON(), nullable=False),
        sa.Column("credential_version", sa.Integer(), nullable=False),
        sa.Column("expires_at", DateTime6, nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("last_verified_at", DateTime6, nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_by", IdType, nullable=True),
        sa.Column("created_at", DateTime6, nullable=False),
        sa.Column("updated_at", DateTime6, nullable=False),
        sa.UniqueConstraint("platform_id", "name", name="uq_managed_platform_account_name"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_managed_platform_account_platform_id",
        "managed_platform_account",
        ["platform_id"],
    )
    op.create_index("ix_managed_platform_account_expires_at", "managed_platform_account", ["expires_at"])
    op.create_index("ix_managed_platform_account_status", "managed_platform_account", ["status"])
    op.create_index("ix_managed_platform_account_created_by", "managed_platform_account", ["created_by"])

    op.create_table(
        "managed_platform_binding",
        sa.Column("id", IdType, primary_key=True, autoincrement=True),
        sa.Column("user_id", IdType, nullable=False),
        sa.Column("platform_id", IdType, nullable=False),
        sa.Column("managed_account_id", IdType, nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", DateTime6, nullable=False),
        sa.Column("updated_at", DateTime6, nullable=False),
        sa.UniqueConstraint("user_id", "platform_id", name="uq_managed_binding_user_platform"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_managed_platform_binding_user_id", "managed_platform_binding", ["user_id"])
    op.create_index("ix_managed_platform_binding_platform_id", "managed_platform_binding", ["platform_id"])
    op.create_index("ix_managed_platform_binding_managed_account_id", "managed_platform_binding", ["managed_account_id"])
    op.create_index("ix_managed_platform_binding_status", "managed_platform_binding", ["status"])

    op.create_table(
        "managed_browser_session",
        sa.Column("id", IdType, primary_key=True, autoincrement=True),
        sa.Column("grant_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", IdType, nullable=False),
        sa.Column("platform_id", IdType, nullable=False),
        sa.Column("managed_account_id", IdType, nullable=False),
        sa.Column("credential_version", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=True),
        sa.Column("expires_at", DateTime6, nullable=False),
        sa.Column("consumed_at", DateTime6, nullable=True),
        sa.Column("created_at", DateTime6, nullable=False),
        sa.UniqueConstraint("grant_hash", name="uq_managed_browser_session_grant"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_managed_browser_session_user_id", "managed_browser_session", ["user_id"])
    op.create_index("ix_managed_browser_session_platform_id", "managed_browser_session", ["platform_id"])
    op.create_index("ix_managed_browser_session_managed_account_id", "managed_browser_session", ["managed_account_id"])
    op.create_index("ix_managed_browser_session_device_id", "managed_browser_session", ["device_id"])
    op.create_index("ix_managed_browser_session_expires_at", "managed_browser_session", ["expires_at"])


def downgrade() -> None:
    op.drop_table("managed_browser_session")
    op.drop_table("managed_platform_binding")
    op.drop_table("managed_platform_account")
