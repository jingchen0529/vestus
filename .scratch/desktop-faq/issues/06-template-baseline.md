# 06 FAQ 文档转结构化 JSON，填充模板与基线

Status: 已完成（2026-11-05）

- 两侧内容同源 `docs/desktop-ark-auto-login-faq.md`，均为 4 组 14 条：
  - 后台模板：`app/services/desktop_faq_template.py`（比原文档多一条「界面以实际版本为准」）；
  - 桌面端基线：`desktop/src/assets/desktopFaqBaseline.json`（仅 title/question/answer，全 active 语义）。
- 同步约束写在模板模块 docstring 与 `FaqView.tsx` 注释里：改客户文案需三处同步（md + 模板 + 基线）。
- 客户端提示速查表（原文档第五节）未转 Q&A：内容与 Q6–Q9 重复，属 UI 专属形态。
