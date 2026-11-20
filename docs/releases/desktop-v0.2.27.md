# Vestus desktop-v0.2.27 版本说明

## 发布信息
- 目标环境：dev 测试环境，Windows x86_64 手动构建包，用于复现托管登录失效设备的问题。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.25`
- 版本范围：在当前 `master` 的三次桌面端准备与验证提交基础上，新增浏览器页面加载诊断监听；构建提交来自隔离分支 `codex/managed-login-observability`，不修改 `master`。

## 本次更新
- 为托管浏览器打开流程的现有 CDP 采集连接增加显式开启的页面加载诊断，监听主文档导航、HTTP 响应、DOMContentLoaded、Load、Network idle、请求完成和请求失败。
- 仅保留规范化页面地址、导航 loader、阶段、耗时、HTTP 状态、错误文本和响应字节数，不采集 Cookie、请求头、请求体或页面交互内容。
- 通过 Tauri `browser-page-load` 事件把诊断结果传到桌面端，平台入口显示最近一次页面加载阶段和耗时，便于在浏览器自动关闭后判断是页面请求失败、登录页导航还是 CDP 监控故障。
- 保留原有托管登录失效与安全监控信号流程，监听不会在打开的网址中执行刷新、导航、登录或其他业务操作。

## 安装与升级
- 计划生成 Windows x86_64 NSIS 安装包 `Vestus-0.2.27-windows-x86_64.exe`，通过 GitHub Actions 的 Windows runner 原生构建；本地 macOS Apple Silicon 无法验证 Windows 安装包。
- 安装测试包前退出旧 Vestus 及其托管浏览器，保留现有 profile 和登录状态，避免旧进程占用托管浏览器环境。
- Windows 安装包、安装后启动、代理链路和托管登录失效复现：未验证，需在目标 Windows 设备上完成。
- macOS Apple Silicon / Intel、Linux x86_64 安装包：未验证，本次手动构建只请求 Windows x86_64。

## 后端配套
- 使用现有 dev 后端和桌面端接口，不新增接口、数据库迁移或部署步骤。
- 继续使用 `/api/user/desktop-config`、`/api/network/ip` 和 `/api/user/network-diagnostics` 等现有接口。
- 页面加载监听只在托管浏览器的本地桌面端和 CDP 采集连接内工作，不向后端上传页面加载事件。

## 验证结果
- `npm ci`：通过。
- `npm test`：189 项通过，0 项失败。
- `npm run build`：通过。
- `npm run check:surfaces`：通过。
- `node --test desktop/scripts/check-surface-boundaries.test.mjs`：49 项通过，0 项失败。
- `node --test desktop/scripts/managed-session-events.test.mjs`：10 项通过，0 项失败。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check`：通过。
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --all-targets`：333 项通过，0 项失败，6 项忽略。
- Windows x86_64 EXE 构建、安装和目标设备上的托管登录失效复现：未验证，等待手动 Windows runner 构建与现场测试。

## 已知限制
- 页面加载诊断显示最近一次事件，不写入独立日志文件；浏览器关闭后桌面端仍可查看关闭前收到的最后一条事件，应用重启后记录清空。
- `Network idle` 依赖 Chromium CDP 生命周期事件，页面长期保持后台请求时可能不会出现该阶段。
- 页面加载事件只对应托管浏览器的主文档，不包含 iframe、图片、脚本等子资源的逐项加载状态，也不提供页面请求出口 IP。
- 代理出口 IP 仍需结合现有网络诊断结果判断；本监听只能证明页面加载阶段和主文档响应结果。
- Windows 设备上的真实代理出口、页面请求和“托管登录失效”触发原因尚未完成现场验收。
