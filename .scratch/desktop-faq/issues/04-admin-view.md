# 04 管理端「帮助内容」独立菜单页

Status: 已完成（2026-11-05）

- 独立导航「帮助内容」：`web/src/components/layout/sidebar.tsx`（NavTab `faq`，全部管理员可见，不在 `isSuperAdminTab` 名单）+ `header.tsx` 标题；路由接入 `web/src/App.tsx`。
- `web/src/components/desktop-faq/desktop-faq-view.tsx`：分组/条目增删改排序、组与条目两级停用开关、字数计数、恢复默认确认弹窗、「用内置内容初始化编辑器」、右侧客户端样式实时预览、普通管理员只读态。
- 校验与后端同规则前置：`web/src/types/desktop-faq.ts`（`validateFaqDocument`）。
- API 方法接入 `web/src/lib/api-client.ts`。
- 回归：`tsc --noEmit` 通过；`npm test` 50/50（含新增 `test/desktop-faq-view.test.mjs`）；`npm run build` 通过。
