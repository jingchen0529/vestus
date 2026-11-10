# 桌面浏览器后台会话回归验收

## 行为约定

- Vestus 仍在运行时，切换应用、失焦、最小化、同一配置的自动/手动刷新不关闭外置浏览器，不重建代理端口或登录环境。
- 短暂访问桌面服务失败不等于账号失效：保留已打开的浏览器、提示不可达并重试；以桌面端已知的 JWT 与用户 `expiresAt` 中较早的截止为界，不延长原有授权期限。当前服务端用户视图通常只下发日期，桌面端按该日期 UTC 日末处理，不能恢复服务端未下发的日内时刻。
- 配置切换或看门狗清理未完成时显示 `browser_cleanup_pending`，不宣称已关闭、不发布新配置或允许新启动；保留原进程管理器及 lease，问题解除后重试清理。
- 退出 Vestus、主动退出登录、明确撤权/认证失效、真实配置租约变化、托管登出和安全监控故障仍走原有清理路径。
- 普通持久 profile 的保存与托管 profile 的一次性清理约定不变；本次不保证第三方网站永不使 Cookie 失效。
- 服务端 lease 仍是保守配置指纹。管理员修改名称/排序等导致 lease 变化时仍会重建；本次只保证未变配置刷新无损，不实现配置热迁移。

## 自动化回归

```sh
npm --prefix desktop test
npm --prefix desktop run build
npm --prefix desktop run check:surfaces
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib
npm --prefix desktop run test:control
npm --prefix desktop run test:persistence
```

`commands::config_sync_tests` 调用实际配置同步命令，使用 Tauri MockRuntime、本地 HTTP 配置/代理服务和内存认证存储，不接触系统钥匙串或客户环境。覆盖重复与并发刷新、代理端口复用、初始化失败重试、服务不可达恢复、401/403、租约变化、同租约有效账号到期、无效配置及旧看门狗隔离。Unix 上另有实际受管子进程保留/清理测试；它不是 Windows GUI 验收。

真实 Chromium 的 control/persistence 测试使用独立临时目录和本地页面，详见 [browser-persistence-testing.md](browser-persistence-testing.md)。它们也不覆盖完整 Tauri 窗口的 Alt+Tab。

## Windows 必测步骤（尚未执行）

使用测试账号、未连接客户业务的测试平台和独立安装/用户环境。保持服务端配置不变；测试时应确认桌面认证仍有效，避免混淆授权到期和焦点事件。

1. 冷启动 Vestus，第一次打开浏览器，记录客户端与浏览器 PID、当前页面及一个可辨识的页面状态。
2. 浏览器 → 记事本等第三方应用 → 浏览器；整个过程不激活 Vestus。确认 PID、页面及登录状态不变。
3. 浏览器 → Vestus → 第三方应用 → 浏览器。首次回焦和超过 60 秒后的再次回焦各验证一次。
4. 分别最小化并恢复 Vestus、浏览器；反复 Alt+Tab 和任务栏切换。所有窗口恢复后均应使用原有会话。
5. 手动刷新平台/配置，并与切回窗口的自动刷新连续触发。平台展示信息可更新，浏览器和代理端口不能重建。
6. 让测试桌面服务暂时返回 503，覆盖超过三轮看门狗校验。现有浏览器保持运行，出现不可达提示；恢复服务后提示解除。不用生产服务器做故障注入。
7. 在独立用例中撤权或返回 401/403，确认旧浏览器清理；重新登录不能被旧请求/看门狗关闭。
8. 真正退出 Vestus，确认浏览器进程树消失，托管目录已清理且 lease 可再次取得；普通 profile 不应误删。

每项记录实际版本、Windows 版本、PID 前后对比、时间和结果。没有 Windows 环境时标记“未验证”，不能用 macOS、纯状态测试或 Chromium 控制测试替代。

## 关闭原因日志

日志位于 Tauri `app_local_data_dir` 下的 `browser-lifecycle.log`；当前 Windows 标准位置为 `%LOCALAPPDATA%\com.zhixi.vestus\browser-lifecycle.log`。

每行 JSON 仅有 `timestamp_unix_ms`、`source`、`reason`、`session_id`、`result`。常见原因：

| reason | 含义 |
| --- | --- |
| `config_changed` | 真正更换配置或有效授权状态变化 |
| `authentication_invalid` | 配置校验发现明确认证失效 |
| `lease_validation_failed` | 无法验证配置的非瞬态协议/校验错误 |
| `desktop_logout` / `app_exit` | 主动退出登录 / 退出程序 |
| `managed_logout` | 托管平台登出检测 |
| `monitor_disconnected` | 托管安全监控连接结束 |
| `process_exited` | 浏览器进程自行退出，由监控线程收尾 |

`requested` 是开始清理，不代表已完成；`completed` 才表示该会话的进程树和受保护清理已完成。失败记录只包含固定错误代码，不记录 Cookie、令牌、密码、完整网址或 profile 路径。

日志为尽力记录：队列最多 64 条、文件最多 256 KiB（满后从新记录开始），锁忙/队列满/磁盘错误可以丢记录，不能因写日志阻止清理。退出最多给写线程 200ms。**没有日志不能证明没有发生关闭**。
