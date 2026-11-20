# Vestus desktop-v0.2.26 版本说明

## 发布信息
- 目标环境：dev 测试环境，本地 macOS Apple Silicon 验证包，不用于生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.25`
- 版本范围：基于当前 `master` 构建基线包，用于验证合并后的代理链路、网络诊断和浏览器 CDP 行为。

## 本次更新
- 默认分支相关的 CI、发布文档和部署文档已切换到 `master`。
- 桌面端测试入口包含网络诊断测试文件。
- 本次构建保留现有代理适配器、代理出口 IP 探测、网络诊断和浏览器 CDP 活动采集实现，供本地实测页面加载与实际请求出口。

## 安装与升级
- 已生成 macOS Apple Silicon DMG `Vestus_0.2.26_aarch64.dmg`，大小约 291 MB。
- DMG 已在临时挂载目录启动，应用版本显示为 `v0.2.26`，未覆盖已有 Vestus 安装。
- 安装前退出旧 Vestus 及其托管浏览器。现有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows x86_64、macOS Intel、Linux x86_64 安装包：未验证。

## 后端配套
- 需要配套 dev 后端，并包含 `0019_desktop_network_metrics` 数据库迁移。
- 桌面端使用 `/api/user/desktop-config`、`/api/network/ip` 和 `/api/user/network-diagnostics` 等接口。
- 本次只准备本地桌面测试包，不部署后端，不执行服务器数据库迁移。

## 验证结果
- 发布说明测试 39 项通过，`desktop-v0.2.26` 发布说明校验通过。
- 桌面端依赖安装完成，锁定版 macOS Apple Silicon Chromium 准备完成。
- 桌面端 `npm test`：184 项通过。
- `npm run build`：通过。
- `npm run check:surfaces`：通过。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check`：通过。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1`：330 项通过、6 项忽略。
- `VESTUS_API_BASE_URL=https://vestus-dev.quanyuos.com npm run desktop:build`：通过，生成 macOS Apple Silicon DMG。
- DMG 校验和、应用 arm64 架构、Chromium arm64 架构和 Chromium 固定版本 `157.0.8103.78`：通过。
- 测试包登录 dev 账号后，平台入口成功启动独立 Chromium，目标页到达 `https://agent.oceanengine.com/admin/homepage`。
- 测试包进程参数包含本地代理 `127.0.0.1:59684`，系统配置显示代理出口 IP `111.160.204.90`。
- 浏览器 CDP 下一轮诊断显示正常，耗时 5 ms。
- 实际页面请求出口 IP 与代理探测 IP 的一致性：未验证。
- 页面加载时间、页面加载状态和 Tauri 页面加载事件：未验证。

## 已知限制
- 当前 `open_browser` 返回浏览器启动和 CDP 会话信息，页面 `DOMContentLoaded`、`loadEventFired`、页面加载失败和页面级加载耗时尚未进入产品事件或诊断字段。
- 现有浏览器 CDP 网络诊断测量 `Browser.getVersion` 的连接响应耗时，不代表目标页面的完整加载耗时。
- `direct_hosts` 命中的域名使用本机直连出口，代理模式下的通用页面请求才经过配置的上游代理。
- 本次实测遵循不在平台页面执行刷新、导航或业务操作的限制，未采集页面级 Network 事件，因此没有完成页面请求出口 IP 比对。
- 本地测试包只用于验证当前实现和采集方案，不代表四平台发布包或生产环境验收结果。
