"""Store desktop network diagnostic samples.

Revision ID: 0019
Revises: 0018
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None
IdType = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
DateTime6 = mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), "sqlite")

def upgrade() -> None:
    op.create_table("desktop_network_metric",
        sa.Column("id", IdType, primary_key=True, autoincrement=True),
        sa.Column("sample_id", sa.String(64), nullable=False), sa.Column("user_id", IdType, nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False), sa.Column("route", sa.String(16), nullable=False),
        sa.Column("target_kind", sa.String(32), nullable=False), sa.Column("network_mode", sa.String(16), nullable=False),
        sa.Column("platform_id", sa.String(128)), sa.Column("browser_id", sa.String(128)),
        sa.Column("measured_at", DateTime6, nullable=False), sa.Column("received_at", DateTime6, nullable=False),
        sa.Column("started_at_ms", sa.BigInteger(), nullable=False), sa.Column("duration_ms", sa.BigInteger()),
        sa.Column("connect_ms", sa.BigInteger()), sa.Column("ttfb_ms", sa.BigInteger()), sa.Column("total_ms", sa.BigInteger()),
        sa.Column("response_bytes", sa.BigInteger()), sa.Column("download_kbps", sa.BigInteger()),
        sa.Column("status", sa.String(16), nullable=False), sa.Column("error_code", sa.String(32)),
        sa.Column("client_version", sa.String(50)),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.UniqueConstraint("user_id", "sample_id", name="uq_desktop_network_metric_user_sample"),
        mysql_engine="InnoDB", mysql_charset="utf8mb4")
    op.create_index("ix_network_metric_user_measured", "desktop_network_metric", ["user_id", "measured_at"])
    op.create_index("ix_network_metric_device", "desktop_network_metric", ["device_id"])
    op.create_index("ix_network_metric_route_mode", "desktop_network_metric", ["route", "network_mode"])
    op.create_index("ix_desktop_network_metric_user_id", "desktop_network_metric", ["user_id"])
    op.create_index("ix_desktop_network_metric_measured_at", "desktop_network_metric", ["measured_at"])

def downgrade() -> None:
    op.drop_table("desktop_network_metric")
