# Vestus desktop-v0.2.15 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 上一成功发布版本为 `desktop-v0.2.12`；本版包含尚未发布成功的 `v0.2.13/v0.2.14` 更新与本次 Apple Silicon runner 修复。
- 使用新标签 `desktop-v0.2.15`，不移动或覆盖已有 `desktop-v0.2.14`。
- 本次仅提交发布配置与说明并打包；不部署服务器、不修改 dev 或生产数据库。不包含工作区中另行开发的后台管理员改密功能。

## 本次更新
### Apple Silicon 构建环境修复
- 将发布矩阵的 Apple Silicon runner 从已退役的 `macos-14` 改为当前受支持的 `macos-15`，继续使用 `aarch64-apple-darwin`，不是切换为 Intel。
- GitHub 官方说明 macOS 14 runner 于 2026-11-02 退役。本次失败注解为 `The configuration 'macos-14-arm64-us-default' is not supported`，没有拿到 runner，也没有执行测试。
- 增加回归检查，防止发布矩阵重新使用已退役的 ARM64 runner。Windows、Linux 和 macOS Intel 构建配置保持不变。

### 包含此前未发布的更新
- 随包 Chromium + 本地页面的真实控制验收、有界 CDP 就绪检查与阶段诊断；正式控制命令三秒期限不放宽，四平台控制门禁均阻塞执行。
- profile 跨进程锁测试显式解锁；后端等价条件校验适配新版 Ruff。
- 托管身份校验三态、独立检查记录及租约误失效修复；账号密码托管由服务端强制自动恢复，管理员写入不再接受恢复开关。
- 中文审计动作与六类筛选；发布前版本说明确认、同提交说明校验和 Release 正文接入。

## 安装与升级
- Windows x86_64：运行 `.exe` 安装程序。
- macOS Apple Silicon / Intel：选择对应架构 `.dmg`，将应用复制至「应用程序」。未做 Apple 开发者签名和公证，首次运行可能需要系统允许。
- Apple Silicon 安装包此次改在 macOS 15 构建；对旧于构建系统的 macOS 兼容性尚未实机验证，不承诺此前系统均兼容。安装前须确认实际安装包的最低系统要求。
- Linux x86_64：`.deb` 或可执行 `.AppImage`；客户端令牌未启用系统钥匙串持久化，重启后需重新登录。
- 升级前退出旧客户端及托管浏览器窗口，使用 dev 桌面用户账号登录。

## 后端配套
- 使用已经部署的 dev 后端 `b80d007` 与迁移 `0017`，本轮不新增迁移、不部署后端。
- `0016` 增加身份检查记录；`0017` 统一开启历史密码托管的自动恢复，不修改凭据与恢复终态。
- 自动恢复依赖服务器 Worker 和 Chromium；不绕过平台验证、不无限重试错误密码。
- 旧后台页面若仍提交 autoRelogin，会被新接口拒绝，需刷新配套页面。

## 验证结果
- 新增 runner 配置回归先在旧配置下失败，改为 macos-15 后通过。桌面 Node 全量 140 项通过，diff 格式检查通过。
- 之前修订提交 `f7404a1` 的 GitHub CI 四项通过。
- `v0.2.14` 的 Windows、Linux、macOS Intel 构建及真实 Chromium 控制、持久化检查已通过；Apple Silicon 因已退役 runner 配置被取消，未执行。Release 因缺平台而未发布。
- 本地 Apple Silicon 随包 Chromium 控制验收连续五次通过；此前 Rust 268 项、Node 139 项、构建和能力边界检查通过。本次只修改 runner 配置及其检查，没有重新跑 Rust、后端或 Web 全套测试。
- 新 `macos-15` Apple Silicon runner 的构建、控制与持久化测试以及本次五个安装包均尚未验证；不能将其他平台成功代替新 runner 验收。

## 已知限制
- GitHub runner 退役无法通过重跑旧 tag 解决，须使用包含新工作流的新提交；历史 tag 保持不变。
- macOS 构建环境变化可能影响最低系统兼容性，需按实际产物验证。
- 四平台控制门禁继续严格执行，任一目标失败则不发布；Windows 持久化步骤仍沿用原有非阻塞策略，须查看具体结果。
- 安装包未做全平台实机验收，也未完成真实方舟账号联测。平台验证码、滑块、二次验证等仍可能阻塞自动登录。
