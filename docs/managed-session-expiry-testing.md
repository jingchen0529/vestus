# 托管会话失效上报与关闭回归

## 上游会话自动校验

方舟平台启用了两类只读探测（`managed_identity.py`，user-info 端点，三态结论）：

1. **保存时校验**：管理员保存 Cookie（全部托管账号写入入口）前先探测。确定失效直接
   拒绝写入（400，"Cookie 校验失败"），坏 Cookie 不进账号池；探测不可达不阻塞保存。
2. **桌面同步前校验**：`GET /api/user/desktop-config` 先跑
   `refresh_session_statuses`，对当前用户所有 valid 状态的 Cookie 账号探测。
   确定失效则经 CAS（`expire_account_session`）标为 expired 并推进凭据版本，
   桌面端列表直接显示失效、bootstrap 拒绝启动。

不变式与缓存：

- 自动探测只允许 valid → expired 单向收紧；expired → valid 只能由管理员保存
  新 Cookie（保存时重新探测）触发。探测失败、平台改版、网络错误一律按未知处理，
  不改状态。
- 探测结论按 (账号, 凭据版本) 进程内缓存：有效结论 5 分钟 TTL，失效结论在
  凭据变更前不再重复请求；未知结论不缓存。
- 探测是产品信号而非安全边界；真正的拦截在 bootstrap 的 session_status 检查。

## 接口约束

`POST /api/user/managed-platforms/{platform_id}/session-expired` 必须携带本次实际注入的 bootstrap 身份：

```json
{
  "sessionId": "123",
  "managedAccountId": 7,
  "credentialVersion": 3,
  "deviceId": "device-a"
}
```

服务端校验当前登录用户、平台、托管账号、凭据版本、已消费状态、设备和 active 绑定。只对当前凭据版本执行条件更新；旧版本和重复请求返回 `applied: false`，不能再次失效新凭据。缺少会话/版本字段的旧客户端请求返回 422，不使用账号 ID 降级处理。

bootstrap 的两分钟 TTL 是消费期限，不是浏览器会话期限。已消费记录必须保留用于后续上报授权。客户端还检查原桌面登录代次，不能用换账号后的令牌补发旧报告。

## profile 生命周期

- 在跨进程 account/profile lease 内检查占用、清空托管目录、启动 Chromium。
- 强杀拥有的进程树，确认退出后清理目录，再释放 lease。
- 退出或删除失败保留会话及 lease，阻止继续用旧 Cookie 启动；成功重试后才通知已关闭。
- 普通手工登录 profile 仍然持久保存，不使用托管清理规则。
- 所谓临时 profile 是“运行期 Chromium 可写，结束后清理”，不是零磁盘写入或安全擦除保证。

## watcher 与固定 login guard 的范围（单连接模型）

托管会话只有**一条** CDP 连接：活动采集连接（v0.2.10 验证的单客户端模型）。
它通过 `Target.setAutoAttach`（`waitForDebuggerOnStart: true`、无过滤、flatten）
暂停所有新 target，按顺序安装 `Page.enable → Runtime.enable → addBinding →
采集脚本 → 登录页交互锁脚本`，最后以 `Runtime.runIfWaitingForDebugger` 放行；
非 page target（Service Worker 等）先放行再断开。同一连接的事件流同时喂给
活动采集与 `LogoutDetector`（登出 URL、登录页 4 秒观察窗）。

> 2026-11-04 变更：废弃独立的第二条防护连接。真实巨量环境中，任何形式的第二条
> autoAttach 连接都会让 `window.open` 弹窗停在 about:blank 永不导航（与命令内容
> 无关，passive 只挂不发也一样）；v0.2.10 的单连接模型无此问题。暂停期间注册的
> 登录防护脚本覆盖弹窗内容页等所有后续文档；附加瞬间已在登录页的极端情况不再
> 单独检测（暂停模型下不存在"未就绪页面"窗口）。检测到登出/登录页停留超窗或
> 连接断开时，采集连接发出 `Expired`/`ConnectionLost` 信号，由命令层执行既有
> 的关闭、上报与前端事件流程；本地故障绝不上报凭据过期。

### 能力与保证的边界

这是普通 Chromium 上的最佳努力产品防护，不是隔离恶意本机用户的安全边界。控制本机、浏览器扩展或调试器的人仍可能修改/禁用脚本、恢复页面或读取运行期数据；临时 profile 和固定 guard 都不提供防提取保证。

Chromium 直接执行 `Target.createTarget(url)` 时，首文档可能在 `targetCreated` 事件前就已经导航并执行代码；自动附加和 `waitingForDebugger: true` 不能保证拦住这段先于目标可见性的执行。CDP 不能承诺在目标出现前阻止其首个脚本。对已发现的未就绪登录页立即失败关闭，是不给后续 4 秒继续使用窗口，**不是**证明关闭之前零闪现、零执行或零输入。

文档起始注入、opacity/inert 和捕获事件不能承诺“任何情况下登录页都不闪现”或“绝不可能输入”。JavaScript 被禁用、脚本安装前的渲染/附加时序、平台改版以及调试连接故障都会影响效果。需要通过本地和授权线上回归观察实际行为，不能将未观察到闪现等同于永久保证。未知路由或未执行预期导航也不保证能发现；网络故障或防护故障不等于平台凭据已失效。

## 可重复的隔离测试

后端使用临时 SQLite fixture，禁止加载本地部署 `.env`：

```sh
PYTHON_DOTENV_DISABLED=1 VESTUS_MANAGED_CHROMIUM_PATH= python3 -m pytest -o addopts='' -q \
  tests/test_managed_platforms.py tests/test_desktop_config_api.py \
  tests/test_browser_activity_api.py tests/test_browser_activity_v2.py \
  tests/test_scope_hardening.py tests/test_auth_api.py
```

Rust 单元回归（不打开旧的可见外网浏览器测试）：

```sh
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib -- \
  --skip target_commands_work_against_a_real_browser
```

真实 Chromium 隔离回归，将环境变量指向已有 Chromium 可执行文件，不使用真实用户 profile：

```sh
VESTUS_TEST_CHROMIUM_PATH="/absolute/path/to/chromium" \
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib real_ -- --ignored \
  --skip real_browser_upgrade_round_trip --skip real_chromium_persistence_matrix
```

这些隔离回归覆盖本地页面重定向、SPA 同文档登出、Cookie 注入顺序、进程树强杀、目录清理、跨进程 lease 和快速重开。它们不访问真实方舟账号，不能替代授权账号的生产平台回归。

### 本地 fake 登录页与多 tab 防护

只使用本地 fake HTTP 页面和测试专用临时 profile，不复用用户目录、不访问生产账号。设置测试 Chromium 路径后，串行运行托管 CDP 集成测试：

```sh
VESTUS_TEST_CHROMIUM_PATH="/absolute/path/to/chromium" \
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib \
  managed_cdp::integration_tests -- --ignored --test-threads=1
```

需要核对的行为：

- 第一个标签、复制/新开标签和连续多 tab 的防护就绪过程，核对 browser page-only 自动附加与 `Page.enable → 固定脚本安装 → Page.getFrameTree → 恢复页面` 顺序，以及并发附加的去重和超时处理。对已就绪页面后续进入登录路由，验证根节点隐藏且 inert，普通键盘输入、粘贴、鼠标、表单提交被拦截。
- `/login` 与 `/login/…` 命中；相似路径、其他 origin、普通查询参数及 SSO 中转不被整站误锁。SPA history 往返与文档导航都同步；自动回工作台时恢复原 root 状态。
- 已就绪 tab 后续进入登录页时独立观察 4 秒。其他 tab 的导航不能无限续期；关闭待判定 tab 不应误报；持续登录页才触发一次对应会话失效信号。
- 真实 Chromium 用 `Target.createTarget(url)` 直接打开 fake 登录页，验证未就绪页面在目标创建/更新、附加或枚举时一经发现即本地 guard failure，不等待 4 秒、不发凭据过期。此测试不能要求首脚本完全未执行或登录页从未闪现；桌面层还须验证关闭本次浏览器和 `monitor_failed` 故障 toast。
- guard 安装被拒绝、连接断开、命令无回执超时与普通关闭分别验证。防护失败不能当成凭据过期；初始防护失败不得继续注入。浏览器关闭与 `managed-session-guard-failed` 的消费/显示还需桌面命令层回归，不能仅凭 CDP 测试断言完整链路通过。

本地测试为了模拟用户和断言 fake 页面状态，可以使用 `Runtime.evaluate` 或输入命令；这不是生产 guard 的权限。边界检查只对固定 guard 与相关生产代码限制能力，不以全工程字符串黑名单误拦测试。

边界检查器自身的隔离 fixture 测试（不需要构建桌面产物）：

```sh
node --test desktop/scripts/check-surface-boundaries.test.mjs
```

实际 `check:surfaces` 依赖最新桌面 build 产物，留待构建完成后执行；fixture 通过不能代替产物检查。前端回归仍包括 `npm --prefix web test`、`npm --prefix web run build`、`npm --prefix desktop test`。

## 发布前仍需验证

- **待用户授权线上复测：第 5 页「本地推」**。在本地 debug 桌面端使用已授权方舟测试账号复现该入口及多 tab 的实际登录/退出路径，区分已就绪页面的 SSO 自动恢复/持续登录页 4 秒后失效，与未就绪页面直达登录页的立即本地故障关闭、不报过期；同时检查主动关闭是否误报。此项尚未完成；不能将本地 fake 页面或构造 URL 的结果写成线上已通过。
- 新开/复制标签直接打开登录页的首文档执行时序与立即失败关闭，必须在目标 Chromium 版本实测；自动附加及 `waitingForDebugger: true` 不证明脚本在登录页面首代码之前安装。不同平台版本、禁用 JavaScript、登录页闪现均需如实记录，不给出绝对保证。
- 防护连接故障和超时须核对桌面层只发送 `managed-session-guard-failed`、不误报凭据过期；正常退出不发送此故障，关闭失败时正确反映 `browserClosed: false`。
- Windows 实机的 Job 进程树、占用查询、文件锁及清理时序；交叉类型检查不能替代运行测试。
- 生产 MySQL 的迁移及并发锁行为；临时 SQLite 测试不能证明生产库一致性。
- 使用已授权测试账号在本地 debug 桌面端点击真实方舟退出登录；不要以构造 URL 测试冒充真实平台登出结果。
- 管理端与桌面端配套更新，旧客户端缺少新上报身份字段时预期被拒绝。
