# 05 桌面端「常见问题」独立菜单

Status: 已完成（2026-11-05）

- Rust：`auth.rs` 增 `fetch_desktop_faq`（与 fetch_desktop_config 同一鉴权姿态）；新命令 `commands/faq.rs::desktop_faq`，白名单结构 + 上限校验（换行合法、其余控制字符整体拒绝），未配置返回 `None`；注册进 `lib.rs`。
- React：侧边栏新增「常见问题」（CircleHelp）；`components/faq/FaqView.tsx` 折叠列表 + 底部固定客服兜底文案；三级降级 服务端 → localStorage 缓存（`vestus-desktop-faq-cache`）→ 内置基线 JSON。
- `tauriBridge.ts` 增 `fetchDesktopFaq`；`App.tsx` 接入 `faq` tab。
- 回归：`cargo check --all-targets` 通过；`cargo test --lib` 263 passed；`tsc --noEmit` 通过；`npm run build` 通过；`npm test` 81/81（含新增 `FaqView.test.mjs`）。
