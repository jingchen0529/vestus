# Vestus desktop-v0.2.21 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.20`。
- 版本范围：网络诊断完整功能、桌面端监控生命周期修复、紧凑诊断卡片、Chromium field-trial A/B 开关和素材分页回归测试入口。
- 本次只提交代码、迁移和桌面发布说明，不部署后端、不执行生产数据库迁移、不推送线上配置。

## 本次更新
- 新增桌面端持续网络诊断，分别采样管理端、VPN/代理链路和活动浏览器 CDP 响应，并将脱敏摘要上报管理端。
- 新增管理端网络诊断列表、用户/设备/路由/状态/时间筛选、分页及 p50/p95/失败率统计。
- 修复配置租约、手动同步、焦点同步、托管恢复和账号切换后的监控重启与旧采样隔离。
- 网络诊断卡片支持平台入口紧凑展示，展开后查看上报队列和丢弃计数。
- 增加 `VESTUS_DISABLE_FIELD_TRIAL_CONFIG` A/B 开关。默认不改变 Chromium 启动行为，启用值为 `1`、`true`、`yes` 或 `on` 时追加 `--disable-field-trial-config`。
- 增加素材分页回归测试入口 `npm run test:material`，仅在提供隔离浏览器 profile、页面 URL、上一页/下一页选择器和 A/B 变量时运行。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包由 `desktop-v0.2.21` 标签构建产生。本机未生成四平台安装包。
- 升级前退出旧 Vestus 及其托管浏览器，保存未提交的平台操作。现有浏览器 profile 和登录状态按当前兼容策略保留。
- macOS 签名、公证、Windows 实机安装和 Linux 安装未在本机验证。

## 后端配套
- 需要先部署包含 `0019_desktop_network_metrics` 的后端，再使用本版桌面端。迁移创建网络指标表和索引。
- 桌面端使用 `/api/user/network-diagnostics` 上报，管理端使用 `/api/admin/network-diagnostics` 查询。后端和数据库部署不在本次打包动作内。
- 代理线路、VPN 凭据和平台账号仍由管理端配置，桌面端不保存或展示代理密码。

## 验证结果
- `npm --prefix desktop test`：177 项通过。
- `npm --prefix desktop run build`：通过。
- `npm --prefix desktop run check:surfaces`：通过。
- `node --test desktop/scripts/test-browser-material.test.mjs`：2 项通过，验证素材测试入口的参数校验和结果校验。
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1`：330 项通过、6 项忽略。忽略项需要真实 Chromium、真实素材页面或前置环境。
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check`：通过。
- `git diff --check`：通过。
- 后端此前在本分支网络诊断实现中完成 `make check`，Ruff、mypy、import-linter 和 494 项 pytest 通过。本次待发布改动未修改后端文件，未重复运行后端门禁。
- 真实素材分页回归、真实 VPN、Windows 原生环境、MySQL 部署、四平台安装包和线上链路：未验证。

## 已知限制
- `npm run test:material` 需要隔离的真实浏览器 profile、页面 URL、上一页/下一页 DOM 选择器和 `VESTUS_MATERIAL_VARIANT`。未提供这些条件时不会运行真实素材回归。
- field-trial A/B 开关只用于受控对照，默认关闭，不代表已确认素材页卡顿由 Chromium 实验配置导致。
- 网络诊断可以区分管理端、VPN/代理和浏览器 CDP 的观测结果，不能单独证明第三方素材页 renderer、GPU、内存或业务接口是根因。
- 当前发布目标为 dev，不面向生产。真实 Windows、VPN 和客户素材操作结果以候选安装包的独立验收为准。
