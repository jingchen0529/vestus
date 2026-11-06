"""Index advertiser page access and freeze future browser identity snapshots.

Revision ID: 0018
Revises: 0017
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

IdType = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
DateTime6 = mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), "sqlite")


def upgrade() -> None:
    # Deliberately no data UPDATE: current credentials cannot identify past runs.
    op.add_column("browser_session", sa.Column("bootstrap_session_id", IdType, nullable=True))
    op.add_column("browser_session", sa.Column("remote_account_id", sa.String(128), nullable=True))
    op.add_column("browser_session", sa.Column("remote_display_name", sa.String(255), nullable=True))
    op.add_column("browser_session", sa.Column("credential_version", sa.BigInteger(), nullable=True))
    op.add_column("browser_session", sa.Column("identity_snapshot_at", DateTime6, nullable=True))
    op.add_column("browser_session", sa.Column("identity_verified_at", DateTime6, nullable=True))
    op.create_index("ix_browser_session_bootstrap_session_id", "browser_session", ["bootstrap_session_id"])

    op.add_column("managed_browser_session", sa.Column("remote_account_id", sa.String(128), nullable=True))
    op.add_column("managed_browser_session", sa.Column("remote_display_name", sa.String(255), nullable=True))
    op.add_column("managed_browser_session", sa.Column("managed_account_name", sa.String(255), nullable=True))
    op.add_column("managed_browser_session", sa.Column("identity_snapshot_at", DateTime6, nullable=True))
    op.add_column("managed_browser_session", sa.Column("identity_verified_at", DateTime6, nullable=True))

    op.create_table(
        "browser_page_advertiser",
        sa.Column("page_id", IdType, nullable=False, primary_key=True, autoincrement=False),
        sa.Column("advertiser_id", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["browser_page_visit.id"], ondelete="CASCADE"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_browser_page_advertiser_advertiser_id", "browser_page_advertiser", ["advertiser_id"])


def downgrade() -> None:
    op.drop_index("ix_browser_page_advertiser_advertiser_id", table_name="browser_page_advertiser")
    op.drop_table("browser_page_advertiser")
    for name in (
        "identity_verified_at", "identity_snapshot_at", "managed_account_name", "remote_display_name", "remote_account_id",
    ):
        op.drop_column("managed_browser_session", name)
    op.drop_index("ix_browser_session_bootstrap_session_id", table_name="browser_session")
    for name in (
        "identity_verified_at", "identity_snapshot_at", "credential_version",
        "remote_display_name", "remote_account_id", "bootstrap_session_id",
    ):
        op.drop_column("browser_session", name)
