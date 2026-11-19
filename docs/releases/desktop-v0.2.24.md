# Vestus desktop-v0.2.24 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.23`。
- 版本范围：修复 Windows runner 上 Chrome for Testing 解压兼容问题，以及 Linux 真实 Chromium 控制测试的页面加载竞态。

## 本次更新
- Windows 随包 Chromium 准备改用 `System.IO.Compression.ZipFile` 的兼容解压入口，避开当前 runner PowerShell `Expand-Archive` 调用不存在的 .NET 重载。
- Linux 真实 Chromium 控制测试在导航报告到达后等待 DOM documentElement 就绪，再读取 managed guard 状态，避免导航提交早于 renderer 文档创建时误报失败。
- 增加 Windows 解压命令回归检查。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.24` 标签构建产生。本机未生成四平台安装包。
- 升级前退出旧 Vestus 及其托管浏览器。现有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.23` 的后端接口和网络诊断迁移要求，需要配套后端包含 `0019_desktop_network_metrics`。
- 桌面端使用 `/api/user/network-diagnostics` 上报，管理端使用 `/api/admin/network-diagnostics` 查询。
- 本次只准备桌面端版本，不部署后端、不执行数据库迁移、不更新服务器。

## 验证结果
- `npm test`：179 项通过。
- `node --test desktop/scripts/prepare-chromium.test.mjs desktop/scripts/test-browser-control.test.mjs`：34 项通过。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1`：330 项通过、6 项忽略。
- `npm run build` 和 `npm run check:surfaces`：通过。
- `npm run test:control`：本机 bundled Chromium 两项真实浏览器控制测试通过。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check` 和 `git diff --check`：通过。
- `desktop-v0.2.23` GitHub Actions 的 Windows Chromium 解压和 Linux 真实控制检查失败；macOS Apple Silicon / Intel 完成安装包构建，Linux 安装包构建成功但真实 Chromium 检查失败，因此 GitHub Release 未创建。
- 本版四平台 GitHub Actions、安装包和 GitHub Release：新 tag 推送后验证。
- Windows runner 上的真实 Chromium 下载、解压与安装：未在本机验证。
- 客户真实素材分页、真实 VPN、线上上报和服务器部署：未验证。

## 已知限制
- `desktop-v0.2.23` 标签保留在原提交，不能移动；本版使用 `desktop-v0.2.24` 新标签。
- 客户真实素材分页回归需要隔离的已登录浏览器 profile、页面 URL、分页选择器和 A/B 变量，未提供这些条件时不运行。
- 本机 bundled Chromium 验证不证明客户 VPN、真实素材页面或目标服务器链路可用。
