"""Request bodies and ORM-to-JSON serializers shared by the HTTP layer.

The DTO classes are the OpenAPI contract: their names become
``components.schemas`` keys and their ``Field`` constraints become the published
validation rules, so neither may be renamed without breaking the web and
desktop clients.  ``serializers`` holds the pure response shaping functions;
anything that needs a database session belongs in ``app.services`` instead.
"""

from __future__ import annotations

from app.schemas.admins import AdminCreate, AdminUpdate
from app.schemas.auth import ChangePasswordRequest, LoginRequest, PasswordReset
from app.schemas.platforms import PlatformCreate, PlatformUpdate, validate_platform_url
from app.schemas.proxies import (
    MAX_BYPASS_HOST_LENGTH,
    MAX_BYPASS_HOSTS,
    MAX_BYPASS_LABEL_LENGTH,
    ProxyCreate,
    ProxyUpdate,
    validate_bypass_hosts,
)
from app.schemas.settings import SettingsUpdate
from app.schemas.users import UserCreate, UserUpdate

__all__ = [
    "MAX_BYPASS_HOSTS",
    "MAX_BYPASS_HOST_LENGTH",
    "MAX_BYPASS_LABEL_LENGTH",
    "AdminCreate",
    "AdminUpdate",
    "ChangePasswordRequest",
    "LoginRequest",
    "PasswordReset",
    "PlatformCreate",
    "PlatformUpdate",
    "ProxyCreate",
    "ProxyUpdate",
    "SettingsUpdate",
    "UserCreate",
    "UserUpdate",
    "validate_bypass_hosts",
    "validate_platform_url",
]
