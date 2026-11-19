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

## 评审修复轮次 1

- 所有 reqwest 响应改为逐 chunk 读取，限制 1 MiB，代理探针同时返回实际读取字节和 body 读取耗时。
- 管理端、代理和 CDP 的 body/握手/读回执路径统一受 8000ms 上限控制。超时样本固定 `totalMs=8000`，未完成阶段保持 null。
- 成功样本不再伪造 `connectMs` 和 `ttfbMs`，吞吐率使用固定上限后的字节数。
- CDP 超时映射 `timeout`，连接关闭映射 `browser_closed`。
- 网络诊断上报新增 generation 校验，拒绝同用户同 profile 的旧会话任务。

修复验证命令及结果：

- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib network_diagnostics -- --test-threads=1`：4 tests passed。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib network_diagnostics_rejects_stale_generation -- --test-threads=1`：1 test passed。
- 追加 `network_diagnostics_receipt_uses_camel_case_contract`，验证 `{accepted, duplicate, protocolVersion}` 反序列化契约，测试通过。
