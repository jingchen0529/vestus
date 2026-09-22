"""per-user proxy assignment and admin binding

The desktop proxy stops being a global singleton: every proxy may be active,
users can be assigned their own node (``user.proxy_id``) and unassigned users
fall back to the single proxy marked as default (``proxy.is_default``).  Users
also gain an owning administrator (``user.bound_admin_id``) so a plain admin
only sees activity of the accounts bound to them.

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-22

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'proxy',
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default=sa.text('0')),
    )
    op.add_column('user', sa.Column('proxy_id', sa.BigInteger(), nullable=True))
    op.create_index(op.f('ix_user_proxy_id'), 'user', ['proxy_id'], unique=False)
    op.add_column('user', sa.Column('bound_admin_id', sa.BigInteger(), nullable=True))
    op.create_index(op.f('ix_user_bound_admin_id'), 'user', ['bound_admin_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_user_bound_admin_id'), table_name='user')
    op.drop_column('user', 'bound_admin_id')
    op.drop_index(op.f('ix_user_proxy_id'), table_name='user')
    op.drop_column('user', 'proxy_id')
    op.drop_column('proxy', 'is_default')
