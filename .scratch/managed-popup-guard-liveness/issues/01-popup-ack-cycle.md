# 明确托管弹窗活性与登录防护边界

Status: resolved — 随包扩展方案落地，四项真实门禁全绿

## 已实现的保守修复

初始 target 保留完整四回执+resume 就绪；后续 target 只先等待固定防护回执，再发订阅和 resume，页面树后置。所有本地初始化/关闭确认有界；单 target 失败只关闭该页并通知；无法确认移除才全局关闭。局部故障不报告凭据失效。重复附着不绕过防护，canonical detach 不能无声遗失监控义务。

## 阻断证据

真实 Chromium 157 macOS ARM64，隔离临时 profile、localhost、真实 `window.open`：异步空白→赋 URL 场景通过，但原生 noopener 新页面 URL 为空，5 秒 target 轮询目标 URL 未到达，测试 exit 101。之后的 noreferrer、跨 origin/慢响应断言未执行，不计通过。

无 `collect` 的两个独立 profile 诊断，分别 runImmediately=true/false：guard 安装 3 秒内无回执；resume 后 guard 回执迟到且无 error，resume 成功。说明这条路径上“guard ACK 在 resume 前”有循环依赖。简化诊断未发送 Page.enable，直达登录文档观察未锁定，不能据此承诺 resume-before-ACK 安全。

## 需要用户决定

- 推荐研究随包最小固定登录防护，在 document_start 运行，避免所有业务弹窗 debugger 暂停；扩展加载/跨平台可用性必须先验证，尚未实施。
- 或明确接受新弹窗首次文档防护注入前的短暂空档，改非暂停后注入；尚未授权。
- 或保留必要回执+超时关闭，接受 noopener 仍不能投放；不算解决用户原始诉求。

### 实现草图（2026-11-21 验证通过后按此落地，验证不过则废弃）

**落地决策（2026-11-21）：**托管统一走扩展模式，删除暂停状态机（生产不可达的死代码不留）；初始页保留 CDP 注入兜底 + 就绪闩（四安装回执即就绪，无 resume）；后续页仅装采集订阅，预算内失败仍只关该页。cdp.rs 生产代码已按此改完（waitForDebuggerOnStart 按模式区分、Install/Monitor 两类回执、无暂停无 resume、dedup/detach 验证/局部关闭保留）。

进行中：
- 扩展目录生成 `write_login_guard_extension`（profile 内、policy 生成 manifest/guard.js）+ `chromium_arguments` 接入 `--load-extension` + commands 启动接线（子代理实现中）。
- 流式回归 19 项改写为扩展模式语义（子代理执行中，红→绿）。
- 后续：真实门禁 fixture 接入扩展路径翻转 noopener 用例；检查器第三次适配（不再强制全局暂停，改强制扩展资产/非暂停不变量）；两轮全量 + 真实门禁组。

- 扩展资产：`desktop/src-tauri/resources/login-guard-extension/`（固定 manifest.json + 固定 guard.js）。guard.js 与现 `login_guard.js` 同源逻辑（幂等标记、route 匹配、捕获拦截、SPA 同步）；route 不再用 CDP 占位符注入，改为扩展读取打包内固定 config 或桌面端每次托管启动写 profile 内扩展目录的 route JSON，以 spike 证据定。
- 启动参数：托管会话在 `chromium_arguments` 追加 `--load-extension=<准备好的扩展目录>`；目录在托管 profile 准备阶段生成/更新，随 profile 清理。直连/普通会话不加。
- 采集器：托管 `setAutoAttach` 改 `waitForDebuggerOnStart: false`，不再依赖 resume；初始 target 保留 Cookie → 完整安装/就绪闩 → 导航作为第二层；后续 target 仅装 Page.enable/lifecycle/树，保留有界 monitor 预算，失败仍只关该页。暂停/ACK 状态机代码路径保留，托管走非暂停分支；`PageClosed`/detach 验证逻辑照旧。
- 门禁与检查器：`check-surface-boundaries` 再次改写（不再强制全局 waitForDebuggerOnStart:true），改为强制「扩展资产存在、仅打包固定脚本、无动态 source、单采集连接、非暂停分支无 resume 依赖」。真实门禁新增：noopener 弹窗首文档含扩展标记且登录页锁定。
- 边界：unpacked 扩展提示条/开发者模式干扰待 spike 观察；Windows `--load-extension` 未验证；扩展可被本机用户禁用，与现 guard 同为最佳努力，不升级安全承诺。

## Comments

- 2026-11-21：用户批准最初保守实现计划；真实测试否证“只等必要回执能正常打开所有投放弹窗”。调整选择工具未收到答案，不推定用户已选择新方案。
- 不发版、不修改代理或 Chromium 沙箱，不降低门禁，不把失败用例移除/跳过。保留现场未解决状态。
- 2026-11-21（第二次）：用户回复「继续执行」，确认先验证推荐路线：随包最小固定登录防护（document_start），弹窗不再 debugger 暂停；CDP 继续负责退出监控与浏览器销毁。验证不过则停下报告，不交付。验证要点：CfT 157 是否支持 `--load-extension`；MV3 content script 是否在 document_start 生效并覆盖 noopener 弹窗首文档；route 配置注入方式；unpacked 扩展提示条干扰；macOS 本地先验证，Windows 实机未验证。

## Comments（续）

- 2026-11-21（最终）：resume 随安装批次无条件发送（flatten autoAttach 挂起行为实测决定）；外来 origin 弹窗 `guard:false` 为路由限定设计语义并写入真实断言。最终两轮：Rust 358/0/8 ×2、Node 355/0、build/边界/检查器 101/101、四项真实门禁两轮全绿（noopener 6.02s/5.41s）。未验证：Windows 实机 `--load-extension`、真实方舟、开发者模式提示条 UI。