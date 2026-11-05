# 02 schema 校验 + 管理端三接口 + 审计

Status: 已完成（2026-11-05）

- `app/schemas/desktop_faq.py`：字段上限、同组重复问题、控制字符（放行 `\n`）、总量 512KB 由路由层 content-length 拦截；错误信息中文带定位。
- `app/api/routers/desktop_faq.py`：`GET/PUT/DELETE /api/admin/desktop-faq` + `GET /template`；GET/模板 普通管理员可读，PUT/DELETE 仅超管；审计 `DESKTOP_FAQ_UPDATED` / `DESKTOP_FAQ_RESET`，detail 只落摘要。
- `app/repositories/desktop_faq.py` + `app/services/desktop_faq.py`：整文档单事务替换。注意点：会话是 `autoflush=False`，replace 后必须显式 flush 才能同事务读回（已修复并在注释说明）。
- 路由注册进 `app/api/routers/__init__.py`（desktop.router 之后）。
