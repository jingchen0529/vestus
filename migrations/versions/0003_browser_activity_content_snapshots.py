"""browser activity content snapshots

Store sanitized URL parameters and the latest bounded input/submit snapshots
alongside each aggregated page visit.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('browser_page_visit', sa.Column('url_params', sa.String(length=4096), nullable=True))
    op.add_column('browser_page_visit', sa.Column('input_snapshot', sa.JSON(), nullable=True))
    op.add_column('browser_page_visit', sa.Column('input_snapshot_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True))
    op.add_column('browser_page_visit', sa.Column('submit_snapshot', sa.JSON(), nullable=True))
    op.add_column('browser_page_visit', sa.Column('submit_snapshot_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('browser_page_visit', 'submit_snapshot_at')
    op.drop_column('browser_page_visit', 'submit_snapshot')
    op.drop_column('browser_page_visit', 'input_snapshot_at')
    op.drop_column('browser_page_visit', 'input_snapshot')
    op.drop_column('browser_page_visit', 'url_params')
