# Vestus desktop-v0.2.28 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.27`

## 本次更新
- 修复托管浏览器「投放弹窗永远空白打不开」：0.2.27 及更早版本用 CDP 暂停新标签页并等待防护脚本回执后才放行，实测 Chrome for Testing 157 上 `noopener`/空 URL 弹窗的防护回执依赖放行本身，形成回执循环，弹窗停在无标题空白页且无任何报错。本版把登录页交互锁改为随包 MV3 扩展（`document_start`、`world: MAIN`、仅匹配托管平台登录 origin），在弹窗首文档执行前生效；托管启动时由桌面端按平台策略生成扩展目录并经 `--load-extension` 加载，扩展准备失败时拒绝启动并提示。
- 托管采集连接不再暂停任何新标签页；`Runtime.runIfWaitingForDebugger` 随安装批次无条件发送（实测 flatten autoAttach 会挂起新 target，与暂停开关无关），其回执只参与初始就绪闩（5 条安装回执）与后续页预算（4 条订阅回执），不再构成防护门禁。
- 初始页面保留「Cookie 注入 → 完整防护就绪 → 首次导航」顺序；CDP 注入的固定登录锁作为扩展之外的第二层兜底（幂等标记，先到者生效）。
- 防护/订阅/放行/关闭确认全部有界超时；单一标签页防护失败只关闭该标签页并核对浏览器 target 列表确认其消失，随后桌面端提示「该标签页防护初始化失败，已关闭，请重试」；无法确认清理才升级为关闭整个浏览器。意外断开的标签页同样必须验证 target 是否存活。
- 局部防护失败不修改凭据、不误报登录失效；明确退出登录与登录页稳定停留仍按既有流程销毁托管浏览器并上报原凭据版本。业务页面与弹窗的输入、点击、提交、滚动不受限制。
- 发布流水线硬化（随版工程改动，此前已在工作区）：`Release` 增加说明文件与后端 API 预检 job、四平台原生准备 Chromium、并发组不取消进行中的发布、手动触发必须指定版本且只产 Artifacts；新增安装包核验脚本（Windows/macOS/Linux）与发布资产脚本及回归；新增手动触发的浏览器回归工作流；macOS 打包目标在 dmg 之外新增 app 目录；固定桌面 Rust 工具链版本。
- 新增仓库社区与文档文件（CONTRIBUTING/SECURITY/dependabot/PR 模板等）并更新 README 与部署文档；Web 端声明 pnpm 版本与 Node 最低版本。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.28` 标签构建产生。
- 升级前建议退出旧 Vestus 客户端。已有浏览器 profile 和登录状态按当前兼容策略保留；托管临时 profile 生命周期不变。
- macOS 签名公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.27` 的接口和 API 地址。
- 本版不新增数据库迁移，不部署后端，不更新服务器。

## 验证结果
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib -- --test-threads=1`：两轮均为 358 项通过、0 项失败、8 项忽略。
- `npm --prefix desktop test`：两轮均为 355 项通过、0 项失败；`npm --prefix desktop run build` 与 `check:surfaces` 两轮通过。
- 检查器自身回归 `node --test desktop/scripts/check-surface-boundaries.test.mjs`：两轮均为 101 项通过、0 项失败；`node desktop/scripts/check-surface-boundaries.mjs` 对生产源通过。
- 控制门禁 harness `node --test desktop/scripts/test-browser-control.test.mjs`：两轮均为 28 项通过。
- 四项真实浏览器门禁（隔离临时 profile + 随包 Chromium，`npm --prefix desktop run test:control`）：两轮全部通过，含此前失败的 noopener 弹窗用例（弹窗 URL 报告到达、首文档含扩展防护标记、`window.opener === null`、登录页锁定、业务弹窗交互正常、外来 origin 无标记且可交互）。
- `cargo fmt --check` 与 `git diff --check`：两轮通过。
- GitHub Actions 四平台构建、安装包签名公证、GitHub Release、Windows 实机 `--load-extension` 行为、真实方舟投放页、客户真实 VPN 与生产 API：未验证。

## 已知限制
- `--load-extension` 在 Chrome for Testing 137+ 品牌构建上已被移除；CfT 是否长期保留该开关、以及 Windows 实机行为未验证。后续升级随包 Chromium 时需重新确认。
- unpacked 扩展可能触发开发者模式相关 UI 提示；macOS 实测无扩展加载报错，但提示条 UI 未做截图级验证。
- 随包扩展可被本机用户禁用，登录锁与 CDP 注入同为最佳努力防护，不构成对抗本机用户的隔离边界。
- 代理或第三方 CDN 响应缓慢时，目标页面首屏加载仍可能较慢。
- 本说明对应 `desktop-v0.2.28`，提交、标签推送和四平台构建尚未执行。
