# Vestus desktop-v0.2.18 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：上一成功发布版本 `desktop-v0.2.15`；包含未发布成功的 `0.2.16/0.2.17` 会话修复。
- 使用新标签 `desktop-v0.2.18`，保留旧标签；四平台构建，Windows 安装包优先提供下载，全部成功后发布 GitHub Release。不部署后端、不执行数据库迁移或回填。

## 本次更新
- 修正 Windows 清单重复嵌入：MSVC 统一通过链接器嵌入 Common-Controls v6，关闭 Tauri 资源文件中的第二份清单，保留图标、版本资源及其他平台原行为。此前 `0.2.17` 报 `CVT1100 duplicate resource / LNK1123`；不跳过测试或更改运行权限。
- 保留后台会话修复：同配置焦点/手动刷新不关闭浏览器或重建代理，合并并发请求，旧登录响应作废，同步失败不自动重开，配置变更可补充同步。
- 临时网络故障保留已有会话并重试，但不延长 JWT/用户授权；退出、注销、撤权、真实配置变化及托管安全事件仍清理。清理失败阻止新配置/新浏览器启动并允许重试。
- 保留本地有界关闭原因日志、构建 API 与说明一致性校验，以及上一版后已合并的密码字符集规则、托管活动启动票据和配套后台功能。

## 安装与升级
- Windows x86_64：退出旧 Vestus 及其浏览器后，安装 `Vestus-0.2.18-windows-x86_64.exe`。无 Windows ARM 原生包。
- macOS 按 Apple Silicon / Intel 选择 `.dmg`，未签名公证，旧系统兼容性未实机验证；Linux x86_64 使用 `.deb` / `.AppImage`，重启需重新登录。
- 用 dev 账号验证首次打开、Alt+Tab/任务栏切换、最小化/恢复、超过 60 秒回焦、手动刷新和退出清理，详见 `docs/browser-background-testing.md`。

## 后端配套
- 本次保活与构建修正不新增迁移；完整托管活动上报需含 `c7853df`、`e5a3edd` 功能的后端及迁移 `0018`，先备份迁移、升级全部后端，再升级桌面；回填另行批准。
- 旧 `b80d007` / `0017` 可能拒绝新增 `bootstrapSessionId` 托管上报（422），非托管路径仅可做有限验证。dev 当前部署/迁移状态未远程核实，本次不代为部署。

## 验证结果
- 清单去重回归先失败后通过；构建辅助逻辑 3 项、前端 150 项、Rust 290 项均通过，Rust 4 项显式环境用例默认忽略；diff 检查通过。前端构建与能力边界在上一轮通过，本次不改前端运行代码。
- `0.2.16` Windows 测试程序加载失败，`0.2.17` Windows 因重复清单链接失败，两版均未生成 Windows 安装包；`0.2.16` 的 macOS 双架构/Linux 构建成功。
- 本次 `0.2.18` 远端构建、Windows 安装及真实切换应用场景仍未验证，须由新构建和安装测试确认。此前本机 macOS 隔离 Chromium 控制/持久化通过，不代替 Windows 验收。
- 严格 Clippy 仍有未改动 `cdp.rs` 的 `unnecessary_sort_by`、`derivable_impls` 提示；Release 无此门禁，不宣称通过。

## 已知限制
- 仅切到第三方应用、从未激活 Vestus 的完整现场链仍需 Windows 实测；安装包是本次交付目标，不要求提前完成该验收。
- 真实 lease 变化仍可能重建浏览器；未做所有配置热迁移或令牌续期。平台 Cookie 有效性及未下发的用户日内截止不能由客户端保证。
- Windows 日志 `%LOCALAPPDATA%\com.zhixi.vestus\browser-lifecycle.log` 最多 256 KiB；日志写入失败不阻塞清理，无日志不证明无关闭。
- 四平台真实控制检查阻塞，Windows 持久化沿用非阻塞策略，须核对日志；Windows artifact 可先下载，正式 Release 等待全平台成功。
