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

- Task 3 当前 TypeScript `NetworkDiagnosticsSnapshot` 只暴露 `samples` 和 `deviceId`，因此上报回执、待上报和丢弃计数没有真实 IPC 数据来源。UI 已预留可选字段并在字段缺失时显示明确的暂无回执与 0，不伪造上传结果。
