# Vestus desktop-v0.2.23 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.22`。
- 版本范围：修复 Windows 并行 Rust 回归中网络监控关闭样本测试的同步竞争。

## 本次更新
- 网络监控测试等待本地 management probe 服务完成第二次响应后，再关闭模拟 CDP 连接，避免依赖 worker 调度速度决定测试结果。
- Windows runner 的核心测试此前因 `worker_emits_browser_closed_on_the_round_after_cdp_closes` 没有按期上报关闭样本而失败。本版修正该测试的同步条件。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.23` 标签构建产生。本机未生成四平台安装包。
- 升级前退出旧 Vestus 及其托管浏览器。现有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.22` 的后端接口和网络诊断迁移要求，需要配套后端包含 `0019_desktop_network_metrics`。
- 桌面端使用 `/api/user/network-diagnostics` 上报，管理端使用 `/api/admin/network-diagnostics` 查询。
- 本次只准备桌面端版本，不部署后端、不执行数据库迁移、不更新服务器。

## 验证结果
- `npm test`：178 项通过。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1`：330 项通过、6 项忽略。
- `npm run build` 和 `npm run check:surfaces`：通过。
- `npm run test:control`：本机 bundled Chromium 两项控制测试通过。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check` 和 `git diff --check`：通过。
- `desktop-v0.2.22` GitHub Actions：Linux x86_64、macOS Apple Silicon、macOS Intel 均完成打包并上传产物；Windows x86_64 核心测试失败，GitHub Release 未创建。
- 本版 Windows GitHub Actions 重试、四平台安装包和 GitHub Release：新标签推送后验证。
- 客户真实素材分页、真实 VPN、线上上报和服务器部署：未验证。

## 已知限制
- `desktop-v0.2.22` 标签保留在原提交，不能移动；本版需使用 `desktop-v0.2.23` 新标签。
- 客户真实素材分页回归需要隔离的已登录浏览器 profile、页面 URL、分页选择器和 A/B 变量，未提供这些条件时不运行。
- 本机和 GitHub 隔离 runner 的控制验证不证明客户 VPN、真实素材页面或目标服务器链路可用。
