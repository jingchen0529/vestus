# 验证记录：托管弹窗防护活性修复（随包扩展方案）

Status: 修复完成，两轮同口径回归全绿；真实投放页与 Windows 实机仍未验证

日期：2026-11-21。修复分支：`fix/managed-popup-guard-liveness`。无 commit/push/打包/部署，工作区原有未提交改动保留。

## 最终方案（与用户确认的路线）

登录页交互锁主防线改为**随包 MV3 扩展**（`document_start`、`world: MAIN`、只匹配托管平台登录 origin），由 `managed_cdp::write_login_guard_extension` 在托管启动时写入 profile 内扩展目录并经 `--load-extension` 加载；扩展准备失败 fail closed（`managed_guard_unavailable`）。

- 采集连接不再暂停任何 target（`waitForDebuggerOnStart = managed.is_none()`）。实测证明暂停模型不可行：flatten autoAttach 下 noopener 弹窗的 `Page.addScriptToEvaluateOnNewDocument` 回执要等 resume 才返回（与 `runImmediately` 无关），构成回执循环——这正是"投放弹窗永远空白"的根因。
- `resume` 在安装批次内**无条件**发送（flatten autoAttach 会挂起新 target，与 waitFor 取值无关）；它的回执只参与初始就绪闩（5 条 Install ACK）与后续页预算（4 条 Monitor ACK），绝不作为防护门禁。
- 初始 target 保留 Cookie → 完整安装/就绪闩 → 首次导航；CDP 注入的 guard 作为扩展之外的第二层（幂等标记，先到者生效）。
- 后续 target 只装采集订阅；防护/订阅/放行/关闭确认全部有界（GUARD_INSTALL_TIMEOUT）；失败只关闭受影响 target，浏览器级 target 列表确认消失后通知 `managed-page-guard-failed`；无法确认移除才升级全局防护故障。意外 detach 也必须验证 target 是否消失。
- 明确退出登录与登录页稳定停留仍走既有 `Expired` 流程销毁整个托管浏览器；局部故障与 `ConnectionLost` 不上报凭据过期。业务页面/弹窗交互不受限制（外来 origin 无标记属路由限定设计，非缺陷）。
- 桌面层新增 `managed-page-guard-failed` 事件与"仅此标签页已关闭"提示；旧 user/auth generation 不通知。

## 关键实证

- CfT 157（macOS arm64，windowed）支持 `--load-extension`；MV3 `world: MAIN` content script 在 noopener 弹窗**首文档**即完成锁定（约 12ms，`readyState:"loading"`，页面首脚本未运行）。隔离世界内联脚本注入在 CfT 157 已失效——旧路线的机制性死因。
- 无采集器时 `window.open` 正常；有采集器（暂停与否）弹窗挂死；手动 resume 后约 18ms 完成 → resume 必须无条件随批次发送。

## 最终两轮（同口径）

| 检查 | 第一轮 | 第二轮 |
|---|---|---|
| Rust 完整串行 lib 回归 | 358 pass / 0 fail / 8 ignored | 358 pass / 0 fail / 8 ignored（99.84s） |
| 桌面 Node 测试 | 355 pass / 0 fail（重写检查器前一轮为 368，-13 为检查器用例数变化） | 355 pass / 0 fail |
| desktop build / check:surfaces | 通过 | 通过（surface boundaries: ok） |
| 检查器自带套件 | 101 pass / 0 fail | 101 pass / 0 fail |
| 控制门禁 harness（node --test） | 28 pass / 0 fail | 28 pass / 0 fail |
| **四项真实浏览器门禁组** | 4/4 通过（target_commands 1.19s / url_only+guard 72.40s / slow-login 17.95s / async-popups 5.41s） | 同左（1.19s / 72.40s / 17.95s / 5.41s 为第二轮实测） |
| cargo fmt --check / git diff --check | 通过 | 通过 |

历史红：`managed_async_popups_remain_interactive_against_a_real_browser` 在扩展接入前连续三次 exit 101（noopener 空 URL）；修复后翻绿并进入强制 harness 清单。未跳过、未弱化任何失败用例。

## 执行命令

```sh
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib -- --test-threads=1
npm --prefix desktop test && npm --prefix desktop run build && npm --prefix desktop run check:surfaces
node --test desktop/scripts/check-surface-boundaries.test.mjs
node --test desktop/scripts/test-browser-control.test.mjs
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
git diff --check
VESTUS_CONTROL_CHROMIUM='<bundled Chromium>' npm --prefix desktop run test:control
```

## 修改文件

- 生产：`desktop/src-tauri/src/cdp.rs`（扩展模式状态机）、`managed_cdp.rs`（`write_login_guard_extension` + 初始 target 判定）、`browser.rs`（`chromium_arguments` 扩展参数 + 启动接线）、`commands/browser.rs`、`commands/managed.rs`（局部失败事件）、`src/App.tsx` + `src/services/tauriBridge.ts`（事件与提示）。
- 测试：`cdp/stream_tests.rs`（25 项扩展模式语义）、`cdp/control_tests.rs`（fixture 扩展参数 + noopener/异步/跨域/慢响应真实回归 + 外来 origin `guard:false` 语义）、`managed_cdp/tests.rs`（生成回归 + 测试用扩展写入器）、`commands/tests.rs`（六种局部错误 + 陈旧身份）、`scripts/check-surface-boundaries.mjs/.test.mjs`（101 项，mutation 全部基于真实生产源）、`scripts/test-browser-control.mjs/.test.mjs`（强制四项门禁清单）。
- 文档：`docs/managed-session-expiry-testing.md`、`.scratch/managed-popup-guard-liveness/{spec.md,issues/01-popup-ack-cycle.md,verification.md}`。

## 未验证与边界

- **Windows `--load-extension` 行为未验证**（CfT 137+ 对品牌 Chrome 移除该开关；CfT 是否受影响需实机确认）。Windows 实机安装、真实方舟投放/登录/退出、真实 VPN/生产链路未验证。
- unpacked 扩展可能触发的开发者模式提示条：macOS 实测 stderr 无扩展报错；UI 气泡未观察（windowed 模式截图级验证未做）。
- 扩展可被本机用户禁用，与 CDP 注入同为最佳努力防护，不构成对抗本机用户的安全边界。
- 交付仍需按项目规则走版本说明审批与四平台构建；本次不 commit/push/打包/部署。
