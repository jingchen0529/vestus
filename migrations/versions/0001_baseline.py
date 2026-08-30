"""baseline

The schema as it stood when Alembic took over, generated with
``--autogenerate`` from ``Base.metadata`` so it matches the ``create_all()``
bootstrap byte for byte.  Databases created before this revision existed are
adopted by ``scripts/init_db.py``, which stamps ``0001`` instead of replaying it.

Revision ID: 0001
Revises:
Create Date: 2026-08-30

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision: str = '0001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('admin',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('role', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('token_version', sa.Integer(), nullable=False),
    sa.Column('last_login_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True),
    sa.Column('last_login_ip', sa.LargeBinary(length=16), nullable=True),
    sa.Column('password_changed_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('updated_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('deleted_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('username', name='uq_admin_username'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_admin_status'), 'admin', ['status'], unique=False)
    op.create_index(op.f('ix_admin_username'), 'admin', ['username'], unique=False)
    op.create_table('platform',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('url', sa.String(length=2048), nullable=False),
    sa.Column('icon_url', sa.Text(), nullable=True),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('updated_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name', name='uq_platform_name'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_platform_sort_order'), 'platform', ['sort_order'], unique=False)
    op.create_index(op.f('ix_platform_status'), 'platform', ['status'], unique=False)
    op.create_table('proxy',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('host', sa.String(length=255), nullable=False),
    sa.Column('port', sa.Integer(), nullable=False),
    sa.Column('username', sa.String(length=255), nullable=False),
    sa.Column('encrypted_password', sa.LargeBinary(), nullable=False),
    sa.Column('bypass_hosts', sa.JSON(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('updated_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name', name='uq_proxy_name'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_proxy_status'), 'proxy', ['status'], unique=False)
    op.create_table('system_setting',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('value', sa.Text(), nullable=False),
    sa.Column('updated_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('key', name='uq_system_setting_key'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_system_setting_key'), 'system_setting', ['key'], unique=True)
    op.create_table('uploaded_file',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('original_name', sa.String(length=255), nullable=False),
    sa.Column('path', sa.String(length=512), nullable=False),
    sa.Column('content_type', sa.String(length=255), nullable=False),
    sa.Column('size', sa.BigInteger(), nullable=False),
    sa.Column('uploaded_by', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_uploaded_file_created_at'), 'uploaded_file', ['created_at'], unique=False)
    op.create_index(op.f('ix_uploaded_file_path'), 'uploaded_file', ['path'], unique=True)
    op.create_index(op.f('ix_uploaded_file_uploaded_by'), 'uploaded_file', ['uploaded_by'], unique=False)
    op.create_table('user',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('company', sa.String(length=200), nullable=True),
    sa.Column('phone', sa.String(length=32), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('expires_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True),
    sa.Column('max_sessions', sa.SmallInteger(), nullable=False),
    sa.Column('token_version', sa.Integer(), nullable=False),
    sa.Column('failed_login_count', sa.SmallInteger(), nullable=False),
    sa.Column('locked_until', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True),
    sa.Column('must_change_password', sa.Boolean(), nullable=False),
    sa.Column('last_login_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True),
    sa.Column('last_login_ip', sa.LargeBinary(length=16), nullable=True),
    sa.Column('created_by', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=True),
    sa.Column('remark', sa.String(length=500), nullable=True),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('updated_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('deleted_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('username', name='uq_user_username'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_user_expires_at'), 'user', ['expires_at'], unique=False)
    op.create_index(op.f('ix_user_status'), 'user', ['status'], unique=False)
    op.create_index(op.f('ix_user_username'), 'user', ['username'], unique=False)
    op.create_table('user_log',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('request_id', sa.String(length=36), nullable=True),
    sa.Column('actor_type', sa.String(length=16), nullable=False),
    sa.Column('actor_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=True),
    sa.Column('actor_username', sa.String(length=64), nullable=True),
    sa.Column('actor_role', sa.String(length=32), nullable=True),
    sa.Column('action', sa.String(length=64), nullable=False),
    sa.Column('target_type', sa.String(length=16), nullable=True),
    sa.Column('target_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=True),
    sa.Column('target_name', sa.String(length=100), nullable=True),
    sa.Column('summary', sa.String(length=500), nullable=False),
    sa.Column('ip_address', sa.LargeBinary(length=16), nullable=True),
    sa.Column('user_agent', sa.String(length=512), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('details', sa.JSON(), nullable=True),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_user_log_action'), 'user_log', ['action'], unique=False)
    op.create_index(op.f('ix_user_log_actor_type'), 'user_log', ['actor_type'], unique=False)
    op.create_index(op.f('ix_user_log_created_at'), 'user_log', ['created_at'], unique=False)
    op.create_index(op.f('ix_user_log_request_id'), 'user_log', ['request_id'], unique=False)
    op.create_index(op.f('ix_user_log_status'), 'user_log', ['status'], unique=False)
    op.create_table('user_platform_assignment',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('user_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('platform_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'platform_id', name='uq_user_platform_assignment'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_user_platform_assignment_platform_id'), 'user_platform_assignment', ['platform_id'], unique=False)
    op.create_index(op.f('ix_user_platform_assignment_user_id'), 'user_platform_assignment', ['user_id'], unique=False)
    op.create_table('user_proxy_assignment',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('user_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('proxy_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
    sa.Column('created_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.Column('updated_at', mysql.DATETIME(fsp=6).with_variant(sa.DateTime(), 'sqlite'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', name='uq_user_proxy_assignment_user'),
    mysql_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_index(op.f('ix_user_proxy_assignment_proxy_id'), 'user_proxy_assignment', ['proxy_id'], unique=False)
    op.create_index(op.f('ix_user_proxy_assignment_user_id'), 'user_proxy_assignment', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_user_proxy_assignment_user_id'), table_name='user_proxy_assignment')
    op.drop_index(op.f('ix_user_proxy_assignment_proxy_id'), table_name='user_proxy_assignment')
    op.drop_table('user_proxy_assignment')
    op.drop_index(op.f('ix_user_platform_assignment_user_id'), table_name='user_platform_assignment')
    op.drop_index(op.f('ix_user_platform_assignment_platform_id'), table_name='user_platform_assignment')
    op.drop_table('user_platform_assignment')
    op.drop_index(op.f('ix_user_log_status'), table_name='user_log')
    op.drop_index(op.f('ix_user_log_request_id'), table_name='user_log')
    op.drop_index(op.f('ix_user_log_created_at'), table_name='user_log')
    op.drop_index(op.f('ix_user_log_actor_type'), table_name='user_log')
    op.drop_index(op.f('ix_user_log_action'), table_name='user_log')
    op.drop_table('user_log')
    op.drop_index(op.f('ix_user_username'), table_name='user')
    op.drop_index(op.f('ix_user_status'), table_name='user')
    op.drop_index(op.f('ix_user_expires_at'), table_name='user')
    op.drop_table('user')
    op.drop_index(op.f('ix_uploaded_file_uploaded_by'), table_name='uploaded_file')
    op.drop_index(op.f('ix_uploaded_file_path'), table_name='uploaded_file')
    op.drop_index(op.f('ix_uploaded_file_created_at'), table_name='uploaded_file')
    op.drop_table('uploaded_file')
    op.drop_index(op.f('ix_system_setting_key'), table_name='system_setting')
    op.drop_table('system_setting')
    op.drop_index(op.f('ix_proxy_status'), table_name='proxy')
    op.drop_table('proxy')
    op.drop_index(op.f('ix_platform_status'), table_name='platform')
    op.drop_index(op.f('ix_platform_sort_order'), table_name='platform')
    op.drop_table('platform')
    op.drop_index(op.f('ix_admin_username'), table_name='admin')
    op.drop_index(op.f('ix_admin_status'), table_name='admin')
    op.drop_table('admin')
