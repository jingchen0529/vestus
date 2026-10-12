# 真实 Chromium 持久化验收

## 运行

在 `desktop/` 执行：

```bash
node scripts/prepare-chromium.mjs  # 已有随包 Chromium 时无需重复下载
npm run test:persistence
```

测试使用随包有头 Chromium、独立临时 profile 和随机端口的本地 HTTP 页面。会短暂打开测试窗口，不登录业务平台，不读取业务 profile。测试直接调用生产 `BrowserSessionManager` 的启动/关闭和 profile 隔离、清理、文件锁路径，不使用无痕模式、mock keychain 或禁用 Cookie 加密。失败时也关闭测试浏览器并清理临时目录。

没有随包浏览器时必须先准备，或显式设置 `VESTUS_PERSISTENCE_CHROMIUM` 为可执行文件的绝对路径。浏览器缺失、没有执行测试、测试断言失败都会以非零状态退出。普通 `cargo test --all-targets` 会明确标记这两项真浏览器测试为 ignored，不能代替上述命令。

Linux 需要 Chromium 运行依赖和显示服务，可使用：

```bash
xvfb-run -a npm run test:persistence
```

## 覆盖与断言

| 场景 | 验证内容 |
| --- | --- |
| 页面写入 | 有过期时间的 Cookie、服务端 HttpOnly Cookie、localStorage、IndexedDB 事务完成后可读；HttpOnly 不暴露给 JS |
| 正常关闭后重开 | 通过 `Browser.close` 关闭，持久数据可读 |
| 客户端关闭流程 | `close_all`、`shutdown` 后重建 manager 并启动 Chromium，持久数据可读 |
| 强杀后重开 | 先正常关闭形成落盘基线，重新打开后强杀，再次打开能读取基线 |
| 账号、平台、代理/直连环境切换 | 新环境没有原数据，切回原环境数据仍在 |
| 账号重置 | 当前账号各平台环境清空，其他账号数据保留 |
| 冷启动页面 | 只有入口页，先前额外打开的标签页不恢复；sessionStorage 不恢复 |

会话 Cookie（无过期时间）记录实际观察值，不承诺一定跨重启保留。平台是否继续认可登录，还受其服务端失效策略影响。强杀测试不保证最后一刻尚未落盘的数据不丢失。

代理/直连测试验证的是 profile 命名空间隔离；测试请求均访问本机，不验证真实代理出口。客户端重启使用生产 manager 的关闭和重新创建模拟，未覆盖 Tauri 登录界面、完整客户端进程重启、系统断电或安装/卸载。

## 升级与回滚

准备同一 Chromium 发行系列、同一操作系统和架构的两个不同版本，保留各自完整安装目录。不要将系统 Chrome 与 Chrome for Testing 混合作为版本升级样本，因为其 Cookie 加密身份可能不同。

```bash
VESTUS_PERSISTENCE_PREVIOUS_CHROMIUM='/absolute/path/to/previous/chrome' \
  npm run test:persistence -- --upgrade
```

当前版本默认取随包 Chromium，也可以用 `VESTUS_PERSISTENCE_CHROMIUM` 指定。测试按“旧版写入并正常关闭 → 新版读取 → 旧版回滚读取”运行，共用同一临时 profile，避免按可执行文件隔离掩盖兼容性问题。实际浏览器版本也必须不同；缺少旧版本时测试失败，不能视作升级验收通过。仅对所测版本对有效，不能推断任意降级都兼容。

## 结果与发布门禁

结果保存在 `desktop/test-results/browser-persistence/`：`persistence.log` 包含版本与逐场景观察，`persistence.json` 包含运行平台和成功状态；版本往返测试对应 `upgrade.log/json`。结果目录不提交 Git。

Release workflow 在四个目标平台打包前运行主矩阵，并上传结果。升级/回滚需要显式提供前一版浏览器，目前不作为默认发布门禁。新增 CI 步骤并不代表已在对应远程 runner 验证通过，应以每次 Actions 结果为准。
