# 01 两表模型 + alembic 迁移

Status: 已完成（2026-11-05）

- `app/db/models/desktop_faq.py`：`desktop_faq_group` / `desktop_faq_item`，无 SQL 外键，`sort_order` 带索引，`status` 沿用 `platform` 表 active/disabled 惯例。
- `migrations/versions/0015_desktop_faq_tables.py`，已在全新 SQLite 上验证 0001→0015 全链路升级。
- 导出接入 `app/db/models/__init__.py`；测试模型接入 `tests/conftest.py`。
