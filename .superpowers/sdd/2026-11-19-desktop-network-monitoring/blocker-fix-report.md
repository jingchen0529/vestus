# 两个阻塞项修复报告

日期：2026-11-19
基线：`072e3af`
分支：`fix/windows-chromium-acl`

## 修复

- 桌面配置同步成功回调统一触发网络诊断控制器。控制器合并重叠启动请求，配置替换时使旧刷新失效并排队新启动，再刷新 `getNetworkDiagnostics()` 快照，租约变化、聚焦/手动同步和托管会话恢复共用该路径。effect 清理、账号替换和退出登录会立即使旧 owner 失效并停止监控，迟到的启动结果不会更新已失效用户的界面。
- Rust `flush_queue_with` 在每次 `report(payload)` 前同时检查停止信号、`run_token` 和 `running`。重试退避返回后若配置替换或停机，旧 payload 会被丢弃并结束 flush，不再上传过期数据。

## 验证

- `node --test desktop/src/services/networkDiagnosticsController.test.mjs`：3 passed。
- `npm test --prefix desktop`：175 passed，0 failed。
- `npm run build --prefix desktop`：TypeScript 和 Vite 构建通过。
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml commands::network::tests`：12 passed，0 failed。
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`：328 passed，5 ignored，0 failed。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml` 和 `git diff --check`：通过。

## 边界

未执行真实 Tauri、Chromium、Windows、线上服务、部署或发布验收。工作区原有未跟踪文件 `.scratch/browser-performance-analysis/video-selection-leak-followup.md` 保持未修改。
