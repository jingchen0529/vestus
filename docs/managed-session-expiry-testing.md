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

## watcher 的范围

监听使用独立 CDP 通道，在 Cookie 注入与导航前建立，并处理命令回执之前的导航事件。只接受对应页面主框架的 `Page.frameNavigated` / `Page.navigatedWithinDocument`，匹配方舟已知 HTTPS SSO 主机和完整登出路径；未知平台不继承通用 `logout` 子串规则。

这仍是最佳努力的产品行为信号，不是登录有效性的安全边界。平台变更退出路径、断开调试通道、未执行预期导航等情况不能保证被发现；网络故障、子框架、普通页面查询参数不能因此被标为失效。

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

这两项测试覆盖本地页面立即重定向、SPA 同文档登出、Cookie 注入顺序、进程树强杀、目录清理、跨进程 lease 和快速重开。它们不访问真实方舟账号，不能替代授权账号的生产平台回归。

前端：`npm --prefix web test`、`npm --prefix web run build`、`npm --prefix desktop test`。

## 发布前仍需验证

- Windows 实机的 Job 进程树、占用查询、文件锁及清理时序；交叉类型检查不能替代运行测试。
- 生产 MySQL 的迁移及并发锁行为；临时 SQLite 测试不能证明生产库一致性。
- 使用已授权测试账号在本地 debug 桌面端点击真实方舟退出登录；不要以构造 URL 测试冒充真实平台登出结果。
- 管理端与桌面端配套更新，旧客户端缺少新上报身份字段时预期被拒绝。
