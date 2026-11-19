# Task 2 Rust 网络探针和认证上报报告

## 实现

- 新增 `network_diagnostics.rs`，定义 `NetworkSample`、`NetworkDiagnosticsSnapshot`、`NetworkDiagnosticsReport`，统一 camelCase 序列化和 8 秒探针上限。
- 管理端探针使用 no-proxy reqwest，记录阶段耗时、总耗时、响应字节和下载速率，固定读取上限并丢弃响应内容。
- 代理探针复用 `probe_via_upstream`，区分代理关闭、代理不可用、代理认证失败、超时和 HTTP 错误。
- 浏览器探针通过 `DevToolsEndpoint` 发送 browser-level `Browser.getVersion`，不执行页面脚本。
- `DesktopAuthState::report_network_diagnostics` 增加固定接口、owner/profile 会话校验、协议版本回执校验。401/403 走普通错误解析，不清理本地 session。
- `lib.rs` 注册模块。

## 验证

- RED：模块未注册时 focused test 因缺少 `NetworkSample` 与 `MAX_PROBE_DURATION_MS` 失败。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib network_diagnostics -- --test-threads=1` 通过，3 tests。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib` 通过，309 passed，5 ignored。
- 未执行真实 API 服务、真实代理服务器和真实 Chromium CDP 的端到端验证。

## 注意事项

- 当前 Rust crate 对新增公开但未接入生命周期的探针函数产生 dead-code warning。Task 1/后续生命周期任务接入后可消除。
- 代理探针沿用现有出口 IP 探针接口，因此成功代理样本的响应字节按返回 IP 文本估算。
