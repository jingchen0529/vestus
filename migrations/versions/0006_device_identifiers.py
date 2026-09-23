"""device identifiers for users and browser sessions

The desktop client now reads the machine identifier its operating system
exposes and reports it on login and with every activity batch.  ``user``
keeps the one from the last login so the console can show which machine an
account is used from; ``browser_session`` keeps a copy per session so a
device's browsing trail can be traced across accounts.

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('user', sa.Column('last_device_id', sa.String(length=64), nullable=True))
    op.create_index(op.f('ix_user_last_device_id'), 'user', ['last_device_id'], unique=False)
    op.add_column(
        'browser_session', sa.Column('device_id', sa.String(length=64), nullable=True)
    )
    op.create_index(
        op.f('ix_browser_session_device_id'), 'browser_session', ['device_id'], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_browser_session_device_id'), table_name='browser_session')
    op.drop_column('browser_session', 'device_id')
    op.drop_index(op.f('ix_user_last_device_id'), table_name='user')
    op.drop_column('user', 'last_device_id')
