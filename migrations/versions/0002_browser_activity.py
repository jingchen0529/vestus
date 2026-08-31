"""browser activity

Adds the two tables the desktop client's activity reports land in.  Both are
append/accumulate only -- see :mod:`app.db.models.browser_activity` for why the
running totals on ``browser_session`` are duplicated from ``browser_page_visit``
and why per-address uniqueness rides on a digest rather than on ``url`` itself.

Generated with ``--autogenerate`` from ``Base.metadata``, so it matches the
``create_all()`` bootstrap the test-suite uses.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('browser_session',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('user_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('session_key', sa.String(length=64), nullable=False),
    sa.Column('browser_id', sa.BigInteger(), nullable=False),
    sa.Column('platform_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('platform_name', sa.String(length=100), nullable=True),
    sa.Column('direct_mode', sa.Boolean(), nullable=False),
    sa.Column('page_count', sa.BigInteger(), nullable=False),
    sa.Column('visits', sa.BigInteger(), nullable=False),
    sa.Column('clicks', sa.BigInteger(), nullable=False),
    sa.Column('inputs', sa.BigInteger(), nullable=False),
    sa.Column('submits', sa.BigInteger(), nullable=False),
    sa.Column('scrolls', sa.BigInteger(), nullable=False),
    sa.Column('dwell_ms', sa.BigInteger(), nullable=False),
    sa.Column('dropped_pages', sa.BigInteger(), nullable=False),
    sa.Column('ip_address', sa.LargeBinary(length=16), nullable=True),
    sa.Column('started_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('last_report_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'session_key', name='uq_browser_session_key'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_browser_session_last_report_at'), 'browser_session', ['last_report_at'], unique=False)
    op.create_index(op.f('ix_browser_session_platform_id'), 'browser_session', ['platform_id'], unique=False)
    op.create_index(op.f('ix_browser_session_started_at'), 'browser_session', ['started_at'], unique=False)
    op.create_index(op.f('ix_browser_session_user_id'), 'browser_session', ['user_id'], unique=False)
    op.create_table('browser_page_visit',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('session_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('url', sa.String(length=500), nullable=False),
    sa.Column('url_hash', sa.String(length=64), nullable=False),
    sa.Column('visits', sa.BigInteger(), nullable=False),
    sa.Column('clicks', sa.BigInteger(), nullable=False),
    sa.Column('inputs', sa.BigInteger(), nullable=False),
    sa.Column('submits', sa.BigInteger(), nullable=False),
    sa.Column('scrolls', sa.BigInteger(), nullable=False),
    sa.Column('dwell_ms', sa.BigInteger(), nullable=False),
    sa.Column('first_seen_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('last_seen_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('session_id', 'url_hash', name='uq_browser_page_visit_url'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_browser_page_visit_last_seen_at'), 'browser_page_visit', ['last_seen_at'], unique=False)
    op.create_index(op.f('ix_browser_page_visit_session_id'), 'browser_page_visit', ['session_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_browser_page_visit_session_id'), table_name='browser_page_visit')
    op.drop_index(op.f('ix_browser_page_visit_last_seen_at'), table_name='browser_page_visit')
    op.drop_table('browser_page_visit')
    op.drop_index(op.f('ix_browser_session_user_id'), table_name='browser_session')
    op.drop_index(op.f('ix_browser_session_started_at'), table_name='browser_session')
    op.drop_index(op.f('ix_browser_session_platform_id'), table_name='browser_session')
    op.drop_index(op.f('ix_browser_session_last_report_at'), table_name='browser_session')
    op.drop_table('browser_session')
