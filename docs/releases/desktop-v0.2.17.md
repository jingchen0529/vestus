# Vestus desktop-v0.2.17 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：上一成功发布版本 `desktop-v0.2.15`；本版包含未发布成功的 `0.2.16` 修复，并补充 Windows 测试程序清单。
- 使用新标签 `desktop-v0.2.17`，不移动已有 `0.2.16`。继续四平台构建，Windows 安装包优先提供下载，全部成功后发布 GitHub Release；不部署服务器、不执行数据库迁移或回填。

## 本次更新
- Windows MSVC 构建显式嵌入 Common-Controls v6 清单，覆盖使用 Tauri MockRuntime 的库测试程序。此前 `0.2.16` 测试程序编译成功但启动时报 `0xc0000139 / STATUS_ENTRYPOINT_NOT_FOUND`，没有执行测试；本次参照 Tauri 自身的测试清单处理方式修正，不跳过测试、不降低安全防护、不要求管理员权限。
- 保留 `0.2.16` 的会话修复：同配置焦点/手动刷新保留浏览器和代理，合并重复请求，旧登录响应不能覆盖新登录；同步失败不继续自动重开，配置变化事件可补充同步。
- 临时网络/服务错误保留已有会话并重试，仍受 JWT 和用户已知授权截止限制；退出、注销、明确撤权、真实配置变化及托管安全事件仍清理。清理失败阻止发布新配置或启动新浏览器。
- 保留本地有界关闭原因日志、构建 API 与说明一致性检查，以及上一版后已合并的密码字符集规则、托管活动启动票据和配套后台功能。

## 安装与升级
- Windows x86_64：退出旧客户端及其浏览器后，安装 `Vestus-0.2.17-windows-x86_64.exe`；无 Windows ARM 原生包。
- macOS：按 Apple Silicon / Intel 选择 `.dmg`，未做 Apple 签名公证；旧系统兼容性未实机验证。Linux x86_64 使用 `.deb` / `.AppImage`，重启后需重新登录。
- 使用 dev 账号，安装后验证首次打开、切到第三方应用、切回 Vestus、最小化/恢复、超过 60 秒再次切换及退出清理。完整步骤见 `docs/browser-background-testing.md`。

## 后端配套
- 本次 Windows 构建修正及浏览器保活不新增后端迁移。
- 整包包含托管活动 `bootstrapSessionId` 字段，完整配套需含 `c7853df`、`e5a3edd` 功能的后端及迁移 `0018`；先备份迁移、升级全部后端，再升级桌面，历史回填另行授权。
- 旧 `b80d007` / `0017` 后端可能以 422 拒绝新托管上报，非托管路径可做有限保活测试，不代表整包兼容。dev 实际后端版本与迁移状态未远程核实；本次不执行部署、迁移或回填。

## 验证结果
- 清单构建辅助逻辑 3 项测试通过；前端全量 150 项通过，构建和能力边界检查通过。
- 本地 Rust 290 项通过、0 失败、4 项显式环境用例默认忽略。此前在本机 macOS Apple Silicon 显式执行隔离 Chromium 控制/持久化矩阵均通过；本次只补 Windows 清单及其回归，不将 macOS 测试视为 Windows 结果。
- `0.2.16` 远端 macOS 双架构和 Linux 构建成功；Windows 在 Rust 测试程序加载阶段失败，未生成 Windows 安装包，GitHub Release 未发布。四个平台的 dev API 一致性检查均通过。
- 新 `0.2.17` Windows 修正后的远端构建、安装及真实 Alt+Tab 尚未验证；待新包构建和安装测试确认。
- 严格 Clippy 此前仍有未改动 `cdp.rs` 的 `unnecessary_sort_by`、`derivable_impls` 提示；现有 Release 无 Clippy 门禁，不宣称该检查通过。

## 已知限制
- 已修复确定的焦点同步关闭路径，但仅切第三方应用的完整现场触发链仍需 Windows 实机验证；本版发布目的就是提供可安装的验证包。
- 真实配置 lease 变化仍可能关闭重建；没有实现所有配置热迁移或令牌续期。平台 Cookie 有效性由平台决定，服务端未下发的用户日内到期时间无法在客户端恢复。
- Windows 日志为 `%LOCALAPPDATA%\com.zhixi.vestus\browser-lifecycle.log`，最多 256 KiB，诊断失败可丢记录但不阻塞清理。
- 四平台控制验收仍为阻塞门禁，Windows 持久化沿用非阻塞策略，须核对具体结果。Windows artifact 可先下载，正式 Release 等待四平台成功。
