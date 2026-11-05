"""Chinese audit labels and categories; persisted event codes stay unchanged."""

from __future__ import annotations

from typing import Any, Literal

AuditLogCategory = Literal[
    "admin_login", "admin_operation", "desktop_login", "desktop_operation", "system", "unknown"
]
AuthSource = Literal["admin", "desktop"]

AUTH_ACTIONS = ("LOGIN", "LOGOUT")
CATEGORY_LABELS: dict[AuditLogCategory, str] = {
    "admin_login": "管理端登录",
    "admin_operation": "管理端操作",
    "desktop_login": "桌面端登录",
    "desktop_operation": "桌面端操作",
    "system": "系统操作",
    "unknown": "来源不明",
}
ACTION_LABELS = {
    "LOGIN": "登录",
    "LOGOUT": "退出登录",
    "CHANGE_PASSWORD": "修改密码",
    "ADMIN_CREATE": "创建管理员",
    "ADMIN_UPDATE": "更新管理员",
    "ADMIN_ENABLE": "启用管理员",
    "ADMIN_DISABLE": "停用管理员",
    "ADMIN_RESET_PASSWORD": "重置管理员密码",
    "ADMIN_DELETE": "删除管理员",
    "USER_CREATE": "创建桌面用户",
    "USER_UPDATE": "更新桌面用户",
    "USER_ENABLE": "启用桌面用户",
    "USER_DISABLE": "停用桌面用户",
    "USER_RESET_PASSWORD": "重置桌面用户密码",
    "USER_DELETE": "删除桌面用户",
    "PROXY_CREATE": "创建代理",
    "PROXY_UPDATE": "更新代理",
    "PROXY_DELETE": "删除代理",
    "PLATFORM_CREATE": "创建平台",
    "PLATFORM_UPDATE": "更新平台",
    "PLATFORM_DELETE": "删除平台",
    "SYSTEM_SETTINGS_UPDATE": "更新系统配置",
    "MANAGED_ACCOUNT_CREATED": "创建托管账号",
    "MANAGED_ACCOUNT_UPDATED": "更新托管账号",
    "MANAGED_ACCOUNT_REVOKED": "撤销托管账号",
    "MANAGED_ACCOUNT_IDENTITY_CHECKED": "检查托管账号登录状态",
    "MANAGED_ACCOUNT_BOUND": "绑定托管账号",
    "MANAGED_ACCOUNT_UNBOUND": "解绑托管账号",
    "MANAGED_ACCOUNT_USER_CREATED": "为用户新增托管账号",
    "MANAGED_ACCOUNT_USER_UPDATED": "更新用户托管账号",
    "MANAGED_ACCOUNT_USER_UPSERTED": "配置用户托管账号",
    "MANAGED_ACCOUNT_USER_DELETED": "解除用户托管账号",
    "MANAGED_SESSION_BOOTSTRAP_ISSUED": "签发托管登录票据",
    "MANAGED_SESSION_BOOTSTRAP_CONSUMED": "使用托管登录票据",
    "MANAGED_SESSION_EXPIRED": "上报托管会话失效",
    "BROWSER_ACTIVITY_REPORT": "上报浏览器活动",
    "DESKTOP_CONFIG_READ": "读取桌面配置",
    "DESKTOP_FAQ_READ": "读取帮助内容",
    "DESKTOP_FAQ_UPDATED": "更新帮助内容",
    "DESKTOP_FAQ_RESET": "恢复默认帮助内容",
}


def audit_category(actor_type: str, action: str, details: Any = None) -> AuditLogCategory:
    """Classify by actor, never by the target account or an action-name prefix.

    Unknown-account login attempts have no actor. Only their server-recorded
    authSource identifies an entry point; older attempts remain unclassified.
    """

    is_login = action in AUTH_ACTIONS
    if actor_type == "admin":
        return "admin_login" if is_login else "admin_operation"
    if actor_type == "user":
        return "desktop_login" if is_login else "desktop_operation"
    if actor_type == "system":
        if not is_login:
            return "system"
        source = details.get("authSource") if isinstance(details, dict) else None
        if source == "admin":
            return "admin_login"
        if source == "desktop":
            return "desktop_login"
    return "unknown"
