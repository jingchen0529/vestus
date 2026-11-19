# Vestus desktop-v0.2.22 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.21`。
- 版本范围：修复发布时真实 Chromium 测试误选客户素材回归项的问题，并稳定网络监控浏览器关闭样本测试。

## 本次更新
- 真实 Chromium 控制门禁改为按测试名分别运行生命周期与 URL-only 管理保护两项测试，避免匹配同一模块下需要客户 profile、账号和素材页面的手工测试。
- 加强控制脚本回归检查，确保每项真实浏览器测试都实际运行、通过且未被忽略。
- 网络诊断 worker 测试改为按 browser_closed 样本完成条件等待，并确定本地 CDP 测试服务处理顺序，降低并行执行时序波动。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.22` 标签构建产生。本机未生成四平台安装包。
- 升级前退出旧 Vestus 及其托管浏览器。现有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.21` 的后端接口和网络诊断迁移要求，需要配套后端包含 `0019_desktop_network_metrics`。
- 桌面端使用 `/api/user/network-diagnostics` 上报，管理端使用 `/api/admin/network-diagnostics` 查询。
- 本次只准备桌面端版本，不部署后端、不执行数据库迁移、不更新服务器。

## 验证结果
- `npm test`：178 项通过。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1`：330 项通过、6 项忽略。
- `npm run build`：通过。
- `npm run check:surfaces`：通过。
- `npm run test:control`：使用随包 Chromium 在本机通过两项真实浏览器控制测试。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check` 和 `git diff --check`：通过。
- 四平台 GitHub Actions 打包、四平台安装包及 GitHub Release：新 tag 推送后验证。
- 客户真实素材分页、真实 VPN、线上上报、Windows 原生环境和服务器部署：未验证。

## 已知限制
- 客户真实素材分页回归需要隔离的已登录浏览器 profile、页面 URL、分页选择器和 A/B 变量，未提供这些条件时不运行。
- 本机真实 Chromium 检查只覆盖 bundled Chromium 的控制生命周期，不证明客户 VPN、真实素材页面或目标服务器链路可用。
- macOS 和 Linux 的 Rust 全量回归由本机完成，Windows 与其他平台结果以新版本 GitHub Actions 构建为准。
