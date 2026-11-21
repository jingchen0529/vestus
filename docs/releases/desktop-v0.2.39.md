# Vestus desktop-v0.2.39 版本说明

## 发布信息
- 目标环境：dev 测试环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 构建方式：手动运行 GitHub `Release` 工作流，只生成 Actions Artifacts。
- 对比版本：最后成功发布的 `desktop-v0.2.27`；`desktop-v0.2.28` 至 `desktop-v0.2.38` 的发布构建失败，本版包含这些提交中的修复。

## 本次更新
- 修复 Windows 安装包验收误报：正确解析 NSIS 写入的带双引号安装目录；仍核对安装路径、版本、卸载命令与卸载器哈希，异常时阻止执行未知卸载器。
- 修复 Rust 清理重试测试的退出通知竞态，区分收到消息与发送回调结束；保留清理成功前不能通知退出和通知只能发送一次的检查，生产清理行为没有变化。
- 相对 0.2.27，托管浏览器通过随包 MV3 扩展在登录页首文档执行前安装交互锁，并保留 CDP 注入兜底；新标签页及时解除调试等待，解决空 URL / noopener 弹窗的防护回执循环。初始页面仍在 Cookie 注入及防护就绪后导航。
- 标签页防护失败时先关闭并确认该标签页消失，提示「该标签页防护初始化失败，已关闭，请重试」；无法确认清理时关闭整个浏览器。局部失败不误报登录失效，业务页面与弹窗的正常输入、点击、提交和滚动继续可用。
- 累计修正跨平台打包校验：Windows 文件路径与 CRLF 测试兼容；macOS Chromium 框架链接解引用识别及签名状态记录；Linux 桌面入口符号链接解析、ELF strip 后构建身份比对；Windows 主程序打包标记差异记录。
- 发布流程增加说明/API 前置检查、四平台原生构建和最终安装包验收、完整资产校验和及失败诊断产物。普通 CI 增加原生 Rust 门禁；提供手动浏览器回归与合成素材 smoke。固定工具链，补充仓库协作、安全和部署文档。

## 安装与升级
- 计划生成 Windows x86_64 EXE、macOS Apple Silicon / Intel DMG、Linux x86_64 deb 和 AppImage，共五个安装包。新版本安装包尚未生成。
- 升级前退出旧 Vestus 客户端，再安装对应平台版本。已有浏览器 profile 和登录状态沿用现有兼容策略；本次打包修复不改变数据格式。
- Windows 运行客户端需要 WebView2 Runtime；CI 安装结构验收记录运行时是否存在，不执行 GUI 登录。macOS 包未完成正式签名与公证；Linux AppImage 需要系统具备相应运行依赖。

## 后端配套
- 沿用 0.2.27 的后端接口和开发环境 API 地址。本次不新增数据库迁移，也不部署或更新服务器。

## 验证结果
- 本机 Node 22.22.2：`npm --prefix desktop test` 358 项通过、0 项失败，1 项 Linux 执行权限检查按平台跳过。
- 安装包校验回归：`node --test desktop/scripts/verify-installers.test.mjs` 15 项通过、0 项失败，1 项按平台跳过；涵盖带引号目录、无引号目录以及六种注册表字段异常。
- 本机 macOS ARM：`cargo fmt --check` 通过；`cargo test --locked --lib` 与最终 `cargo test --locked --all-targets` 均为库测试 358 项通过、0 项失败、8 项需要额外条件的测试未运行。退出回调竞态回归连续运行 20 次通过。
- `npm --prefix desktop run build` 的 TypeScript/Vite 构建、`npm --prefix desktop run check:surfaces` 和 `git diff --check` 通过；GitHub 工作流与文档契约测试 12 项通过。
- 旧版 0.2.38 的 GitHub run `44901265388` 第 2 次执行：Linux、macOS ARM、macOS Intel 构建及最终安装包验收通过；Windows 在安装目录注册表校验失败。本次已依据实际字段输出复现并修复该错误，此旧版结果不代表 0.2.39 已通过。
- 0.2.39 的 GitHub 四平台打包与 Windows 原生安装/ACL/卸载：未验证。需在说明获准后提交代码与说明，再执行手动构建。

## 已知限制
- Windows 真实安装包仍需在原生 runner 完成验收；本机 fixture 成功不代替实际安装成功。
- Windows 浏览器持久化门禁现有失败仍按流水线记录为非阻断；真实业务登录、客户 VPN、方舟投放页面与 Windows 实机扩展行为未验证。
- Chrome for Testing 对 `--load-extension` 的支持需在后续 Chromium 升级时重新确认；随包扩展仍可被本机用户禁用，可能出现开发者模式提示。
- macOS ARM 包的 ad-hoc 签名可能因框架链接解引用失效，目前记录为未签名；正式签名、公证和各平台用户机器安装均未验证。
- GitHub 原生浏览器控制曾出现 `Page.navigate` 超时；0.2.38 第 2 次执行通过，但无法据此保证后续 runner 不再出现瞬时超时。
