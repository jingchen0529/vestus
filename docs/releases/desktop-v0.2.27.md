# Vestus desktop-v0.2.27 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.26`

## 本次更新
- 调整托管浏览器新页面的防护注入顺序。托管页面先安装只作用于巨量方舟 `/login` 路由的固定 guard，再启用 Page 事件，避免空 URL 弹窗在调试暂停期间丢失后续导航赋值。
- 保持业务页面的正常交互。固定 guard 只在同源 `/login` 及其子路径设置 `inert`、透明度和输入事件拦截，业务页面不进入登录锁定状态。
- 增加普通弹窗和托管弹窗的空 URL 打开回归覆盖，包含 `window.open("", ...)` 后设置 `location` 的导航链路。
- 更新托管边界检查，确保固定 guard 的来源、单连接模型和新的命令顺序继续受 CI 约束。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.27` 标签构建产生。本机尚未生成四平台安装包。
- 升级前建议退出旧 Vestus 客户端。已有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.26` 的接口和 API 地址。
- 本版不新增数据库迁移，不部署后端，不更新服务器。

## 验证结果
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib`：339 项通过，7 项忽略，0 项失败。
- `npm --prefix desktop test`：286 项通过，0 项失败。
- `npm --prefix desktop run build`：通过。
- `npm --prefix desktop run check:surfaces`：通过。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check` 和相关 `git diff --check`：通过。
- bundled Chromium 托管弹窗回归：1 项通过，0 项失败，包含普通弹窗、托管弹窗、空 URL 弹窗和登录页交互，耗时约 72 秒。
- `node --test desktop/scripts/check-surface-boundaries.test.mjs`：61 项通过，0 项失败。
- 本版四平台 GitHub Actions、安装包签名、公证、客户真实 VPN、生产 API 和 GitHub Release：未验证。

## 已知限制
- 真实客户浏览器 profile、真实平台登录态、客户 VPN 和生产服务链路未验证。
- 代理或第三方 CDN 响应缓慢时，目标页面仍可能需要较长时间完成首屏加载。
- 本说明对应 `desktop-v0.2.27`，提交、打包、标签推送和四平台构建尚未执行。
