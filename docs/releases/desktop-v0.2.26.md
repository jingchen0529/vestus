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
- 本次只构建 macOS Apple Silicon 本地测试包，预计生成 DMG 和应用包。
- 安装前退出旧 Vestus 及其托管浏览器。现有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows x86_64、macOS Intel、Linux x86_64 安装包：未验证。

## 后端配套
- 需要配套 dev 后端，并包含 `0019_desktop_network_metrics` 数据库迁移。
- 桌面端使用 `/api/user/desktop-config`、`/api/network/ip` 和 `/api/user/network-diagnostics` 等接口。
- 本次只准备本地桌面测试包，不部署后端，不执行服务器数据库迁移。

## 验证结果
- 发布说明校验、桌面端依赖安装、TypeScript/Vite 构建、Rust 编译、Tauri 打包和本地安装启动：未验证。
- 代理出口 IP 与实际页面请求出口的一致性：未验证。
- 浏览器页面加载时间、加载状态和 Tauri 事件需求：未验证。
- 真实 dev API、真实代理节点、托管账号和已登录平台页面：未验证。

## 已知限制
- 当前 `open_browser` 返回浏览器启动和 CDP 会话信息，页面 `DOMContentLoaded`、`loadEventFired`、页面加载失败和页面级加载耗时尚未进入产品事件或诊断字段。
- 现有浏览器 CDP 网络诊断测量 `Browser.getVersion` 的连接响应耗时，不代表目标页面的完整加载耗时。
- `direct_hosts` 命中的域名使用本机直连出口，代理模式下的通用页面请求才经过配置的上游代理。
- 本地测试包只用于验证当前实现和采集方案，不代表四平台发布包或生产环境验收结果。
