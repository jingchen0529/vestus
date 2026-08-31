"""ORM models, one module per aggregate.

Importing this package imports every model, which is what ``Base.metadata``
needs to be complete for ``create_all()`` and for Alembic autogeneration.
"""

from __future__ import annotations

from app.db.models.admin import Admin
from app.db.models.assignment import UserPlatformAssignment, UserProxyAssignment
from app.db.models.browser_activity import BrowserPageVisit, BrowserSession
from app.db.models.log import UserLog
from app.db.models.platform import Platform
from app.db.models.proxy import Proxy
from app.db.models.setting import SystemSetting
from app.db.models.upload import UploadedFile
from app.db.models.user import User

__all__ = [
    "Admin",
    "BrowserPageVisit",
    "BrowserSession",
    "Platform",
    "Proxy",
    "SystemSetting",
    "UploadedFile",
    "User",
    "UserLog",
    "UserPlatformAssignment",
    "UserProxyAssignment",
]
