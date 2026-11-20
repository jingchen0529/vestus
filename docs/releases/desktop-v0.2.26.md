# Vestus desktop-v0.2.26 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.25`
- 版本范围：登录失效判定与浏览器防护时序修复、浏览器复用与自动关闭处理、网络诊断 CDP 展示调整。

## 本次更新
- 增加登录失效的加载完成门禁。主 frame 必须完成加载并继续停留在 `/login`，才会开始失效计时。新的 loader 会清理旧计时，慢加载不会被误判为凭据失效。
- 增加 Expired 确认宽限，并区分凭据失效、加载失败和 CDP 连接断开。连接断开只关闭本地浏览器，不修改托管凭据。
- 调整托管浏览器装载顺序。先安装 Cookie、采集器和固定防护脚本，确认 guard ACK 与 resume 完成后再导航首文档。
- 浏览器已有对应页面时直接激活。其他桌面实例或重启后遗留的浏览器如果仍被占用且 CDP 可用，也会直接复用。
- 浏览器页面已关闭时由桌面端关闭旧浏览器并重新启动，不再要求客户手动关闭后重试。外部浏览器关闭等待超过 5 秒时仍会返回关闭超时错误。
- 网络诊断在 CDP 端点就绪后立即重采样。无有效 CDP 样本时隐藏浏览器 CDP 项，不影响管理端和 VPN 代理展示。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.26` 标签构建产生。本机尚未生成四平台安装包。
- 升级前建议退出旧 Vestus 客户端。已有浏览器 profile 和登录状态按当前兼容策略保留，桌面端会处理可识别的残留浏览器窗口。
- macOS 签名、公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.25` 的接口和网络诊断上报要求。
- 使用 `/api/user/network-diagnostics` 上报，管理端使用 `/api/admin/network-diagnostics` 查询。
- 本版不新增数据库迁移，不部署后端，不更新服务器。

## 验证结果
- 本机 `cargo test --locked --lib`：339 项通过，7 项忽略，0 项失败。
- 本机 `npm test`：205 项通过，0 项失败。
- 本机 `npm run build`：通过。
- 本机 `npm run check:surfaces`：通过。
- 本机 `cargo fmt --all -- --check` 和 `git diff --check`：通过。
- 本机 bundled Chromium 控制门禁三项：通过，包含慢加载登录页回归。
- 本版四平台 GitHub Actions、安装包签名、公证、客户真实 VPN、生产 API 和 GitHub Release：未验证。

## 已知限制
- 外部浏览器复用只激活页面，不接管该浏览器的生命周期。桌面端自动关闭外部旧浏览器时，最多等待 5 秒确认 profile 释放。
- 真实客户浏览器 profile、真实平台登录态、客户 VPN 和生产服务链路未验证。
- 本说明对应 `desktop-v0.2.26`，标签推送和四平台构建尚未执行。
