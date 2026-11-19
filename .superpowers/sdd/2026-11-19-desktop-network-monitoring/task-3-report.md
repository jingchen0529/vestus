# Task 3 实现报告

## 范围

完成 Rust 网络诊断监控生命周期、浏览器最近活动会话选择、Tauri IPC 和 TypeScript bridge。监控由单一 Tokio task 驱动，首轮立即执行，后续按 60 秒间隔执行。每轮最多采集管理端和最近浏览器两类样本。旧认证代次在上报返回 `session_changed` 或 `unauthenticated` 后终止，避免继续使用旧 token。内存上报队列限制为 120 条，成功上报后删除，失败保留等待下一轮。

## 改动

- `desktop/src-tauri/src/browser.rs`
  - 增加只读最近活动会话快照，记录平台、直连模式、活动时间和 CDP 端点。
  - 复用或新启动浏览器时刷新活动时间，关闭中的会话不会进入快照。
- `desktop/src-tauri/src/commands/network.rs`
  - 增加 `NetworkMonitor`、采样 task、取消代次、队列上限、快照事件和三个 Tauri command。
- `desktop/src-tauri/src/commands.rs`、`lib.rs`
  - 注册网络诊断模块、状态和 commands。
- `desktop/src/services/tauriBridge.ts`
  - 增加快照类型、拉取、启动、停止和事件订阅 bridge。

## 验证

- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::network -- --test-threads=1` 通过，2 个测试。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib browser -- --test-threads=1` 通过，57 个通过，5 个按环境跳过。
- `npm --prefix desktop run check:surfaces` 通过。
- `npm --prefix desktop run build` 通过。
- `npm --prefix desktop test -- networkDiagnostics.test.mjs` 未发现该文件，Node 测试入口仍执行并通过已有测试集合。

## 取舍与限制

- 当前运行时没有直接暴露上游代理凭据，因此监控采集管理端和最近浏览器 CDP，代理链路样本沿用已有诊断 API 的能力边界，未在本任务中复制凭据或绕过 adapter。
- 配置代次变化会在网络诊断上报被服务端拒绝为当前会话时终止旧任务。未引入新的配置状态监听器。

## 修复轮次 1（2026-11-19）

- 每轮新增 VPN 样本，当前 adapter 上游上下文不可安全复制时使用 `measure_proxy(None, ...)`，明确产出 `proxy_disabled`，不向 React 暴露凭据。
- 监控增加 `Notify` 唤醒信号，`open_browser` 的复用和新启动路径都会触发立即采样。
- worker 退出时清理 `running` 与 stop sender，旧认证代次结束后可重新启动。
- 上报失败保留队列并按 5 秒、30 秒、2 分钟退避重试，成功后继续清空队列。

新增验证命令及结果：

- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::network -- --test-threads=1`：通过，2 个测试。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::config_sync_tests -- --test-threads=1`：通过，12 个测试。

## 修复轮次 2（2026-11-19）

- ActivityCollector 现接受只读 activity hook，CDP 观察到事件时刷新对应浏览器的 `last_active`，不读取或传递页面内容。
- 上报退避等待通过 `tokio::select!` 同时监听停止 channel，登出或停止监控会立即中断 5 秒、30 秒和 120 秒等待。
- 新增 VPN 样本和退避边界测试，验证浏览器活动 hook 走现有 CDP 采集路径。

验证：

- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::network -- --test-threads=1`：通过，4 个测试。

## 修复轮次 3（2026-11-19）

- 认证代次变化时，`start` 会停止旧 worker 并允许新代次立即启动，避免旧任务占用 running 状态。
- 采样轮固定包含管理端、VPN 和浏览器三类样本。没有最近浏览器时，浏览器样本显式为 `cdp_unavailable`。
- 补充 cadence、非重入、三样本组成、旧代次重启、队列上限、VPN 失败和退避边界测试。

验证：

- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::network -- --test-threads=1`：通过，9 个测试。

## 修复轮次 4（2026-11-19，测试加固）

- 将监控 worker 的采样、上报、事件发布和退避等待收敛到同一内部 callback seam，生产启动路径仍使用真实 `collect_samples`、`DesktopAuthState` 和 Tauri event。测试通过同一 worker loop 注入可控 callback，不再直接改写运行状态或只比较常量。
- 新增真实生命周期测试，覆盖首轮立即执行、60 秒 cadence、相同认证代次不重入、`wake` 唤醒且不会打断进行中的采样、`collect_samples` 的管理端/VPN/浏览器三样本顺序和错误字段、最近活动浏览器的 platform/direct mode 选择、认证代次切换时旧 worker 不发布样本、stale-auth 上报终止并允许新代次启动、120 条队列保留、成功 flush 删除、失败退避和取消时保留队列。
- 增加仅用于 Rust 测试的浏览器会话 fixture seam，避免启动真实 Chromium；没有改变公开 Tauri 行为。

验证：

- `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`：通过。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::network -- --test-threads=1`：通过，7 个测试。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib browser -- --test-threads=1`：通过，59 个测试通过，5 个按环境跳过。
- `git diff --check`：通过。

## 修复轮次 5（2026-11-19，补齐测试覆盖）

- 使用现有 worker callback seam 增加浏览器关闭轮次测试。首轮本地 CDP 返回成功，唤醒下一轮后 CDP 端点发送关闭帧，断言事件快照产出 `browser_closed`，并保留最近浏览器的 `browserId`、`platformId` 和网络模式。
- 使用 Tokio paused clock 增加失败上报退避边界测试，分别断言 5 秒、30 秒和 120 秒到点前不重试、到点后重试，预算耗尽后队列仍保留。

验证：

- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib commands::network -- --test-threads=1`：通过，9 个测试。
- `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`：通过。
- `git diff --check`：通过。
