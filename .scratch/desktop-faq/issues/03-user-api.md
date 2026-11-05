# 03 用户端 GET /api/user/desktop-faq + 内置模板常量

Status: 已完成（2026-11-05）

- `GET /api/user/desktop-faq`（user_auth）：只组装 `active` 的组与条目；无行/全停用返回 `{"faq": null}`；审计 `DESKTOP_FAQ_READ` 走 `record_standalone`。
- 明确不进 desktop-config lease 看门狗（避免改一条文案触发全员「配置已更新」toast），客户端打开面板时拉取。
- 模板常量 `app/services/desktop_faq_template.py`（`DEFAULT_DESKTOP_FAQ_TEMPLATE`，源自 `docs/desktop-ark-auto-login-faq.md`，4 组 14 条），经 `/api/admin/desktop-faq/template` 供管理端「初始化编辑器」预填。
