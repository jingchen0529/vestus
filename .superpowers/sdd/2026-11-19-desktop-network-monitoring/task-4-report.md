# Task 4 实现报告

## 范围

完成桌面端网络诊断卡片和复用视图模型。卡片接收 Task 3 的 IPC 快照，只读展示最近采样时间、管理端、VPN 代理、浏览器 CDP 三条链路，以及上报回执、待上报数量和丢弃数量。采样失败只映射为诊断状态，不修改代理或沙箱偏好。

## 改动

- `desktop/src/components/network/NetworkDiagnosticsCard.tsx`
  - 使用现有 Card、Badge、Icon 组件。
  - 覆盖空态、采样中、正常、代理认证失败、代理不可用、CDP 不可用、浏览器关闭、上报失败等状态。
  - 响应式网格在窄宽布局都保留三条链路和最近采样时间。
  - 不调用 fetch、invoke 或 startNetworkDiagnostics，避免出现第二个测速入口。
- `desktop/src/components/network/networkDiagnosticsView.ts`
  - 将 IPC 样本按 route 选择最近值，并做 UI 层中文状态码映射。
  - 兼容未来可选的 uploadStatus、queuedCount、queueCount、droppedCount、droppedSamples 字段。当前 bridge 未提供时显示暂无回执和 0。
- `desktop/src/components/browser/PlatformLauncher.tsx`
  - 在平台入口顶部展示诊断卡片。
- `desktop/src/components/settings/SystemSettings.tsx`
  - 在系统配置顶部复用同一诊断卡片。
- `desktop/src/App.tsx`
  - 登录且桌面认证有效时拉取初始快照并订阅 `network-diagnostics-changed`。
  - 账号切换、退出或卸载时清理订阅和快照状态。
- `desktop/src/components/network/NetworkDiagnosticsCard.test.mjs`
  - 新增组件边界测试，覆盖状态、无第二测速入口、响应式布局和 App 双入口接线。

## 验证

- `npm --prefix desktop test -- NetworkDiagnosticsCard.test.mjs`：通过，169 个测试。
- `npm --prefix desktop run build`：通过。
- `npm --prefix desktop run check:surfaces`：通过。
- `git diff --check`：通过。

## 已知限制

- 对旧版 Rust worker 发出的快照，新增上报字段可能缺失。前端保留兼容默认值并显示暂无回执与 0。当前 Task 3 worker 已更新为真实维护这些字段。

## 修复轮次 1（2026-11-19）

- App 认证并完成配置同步后显式调用 `startNetworkDiagnostics`，事件订阅和初始快照读取均受登录代次与 active guard 保护。
- 账号切换、组件清理、会话失效和显式退出会调用 `stopNetworkDiagnostics`，避免旧 worker 继续采样。
- Rust `NetworkDiagnosticsSnapshot` 增加 `uploadStatus`、`queuedCount`、`droppedCount`，由监控 worker 在入队、上报成功和重试状态变更时更新并通过 IPC 事件发送。队列溢出累计丢弃计数。
- TypeScript bridge 类型和卡片视图改为消费真实字段，保留缺失字段的兼容默认值。
- DNS、TLS、未知及缺失错误码统一显示中文诊断状态，不泄漏原始码。

新增验证：

- `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`：通过。
- `npm --prefix desktop run build`：通过。
- `npm --prefix desktop test -- NetworkDiagnosticsCard.test.mjs`：通过。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::network -- --test-threads=1`：通过，9 个网络监控生命周期测试。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib network_diagnostics -- --test-threads=1`：通过，9 个诊断与 IPC 序列化测试。
- `npm --prefix desktop run check:surfaces`：通过。
- `git diff --check`：通过。
