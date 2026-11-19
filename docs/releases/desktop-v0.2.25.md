# Vestus desktop-v0.2.25 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.24`。
- 版本范围：补齐 Windows runner 上网络监控样本单测隔离，并保留 Windows Chromium 解压兼容和 Linux renderer 文档就绪修复。

## 本次更新
- 网络监控 worker 测试改用确定性采集 hook 验证 browser_closed 样本进入快照和上报队列，去掉 worker 单测中重复启动 TCP 和 WebSocket 的跨进程时序依赖。
- Windows Chrome for Testing 准备使用兼容的 .NET ZipFile 解压 API。
- Linux 真实 Chromium 控制测试在导航报告之后等待 renderer 的 documentElement 创建，再检查 managed guard 状态。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.25` 标签构建产生。本机未生成四平台安装包。
- 升级前退出旧 Vestus 及其托管浏览器。现有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.24` 的后端接口和网络诊断迁移要求，需要配套后端包含 `0019_desktop_network_metrics`。
- 桌面端使用 `/api/user/network-diagnostics` 上报，管理端使用 `/api/admin/network-diagnostics` 查询。
- 本次只准备桌面端版本，不部署后端、不执行数据库迁移、不更新服务器。

## 验证结果
- 本机 `npm test`：179 项通过。
- 本机 `node --test desktop/scripts/prepare-chromium.test.mjs desktop/scripts/test-browser-control.test.mjs`：34 项通过。
- 本机 `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1`：330 项通过、6 项忽略。
- 本机 `npm run build`、`npm run check:surfaces` 和两项 bundled Chromium 控制测试：通过。
- `desktop-v0.2.24` GitHub Actions：macOS Apple Silicon、Linux x86_64 完成构建并上传安装包；Windows 核心测试再次在 `worker_emits_browser_closed_on_the_round_after_cdp_closes` 失败；macOS Intel 最终构建未完成，GitHub Release 未创建。
- 本版四平台 GitHub Actions、Windows 原生解压、安装包和 GitHub Release：新标签推送后验证。
- 客户真实素材分页、真实 VPN、线上上报和服务器部署：未验证。

## 已知限制
- `desktop-v0.2.24` 标签保留在原提交，不能移动；本版使用 `desktop-v0.2.25` 新标签。
- 客户真实素材分页回归需要隔离的已登录浏览器 profile、页面 URL、分页选择器和 A/B 变量，未提供这些条件时不运行。
- 本机 bundled Chromium 验证不证明客户 VPN、真实素材页面或目标服务器链路可用。
