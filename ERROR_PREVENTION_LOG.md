# 错误与防复发记录

## 2026-11-21：Windows 安装目录注册表格式与退出回调时序

- **Windows 打包失败证据**：`desktop-v0.2.38` 的 GitHub Actions run `44901265388` 第 2 次执行，Windows 在 `Verify final installers` 失败。产品名、版本、卸载命令和卸载器 SHA256 均匹配；`InstallLocation` 是带外层双引号的路径。Tauri CLI 2.11.4 的 NSIS 模板有意按此格式写入，直接交给 `path.resolve` 会把引号当成路径字符。
- **修复与自动化**：仅去除平衡且不含内层引号的一对外层双引号，再核对自有安装目录。卸载命令仍精确匹配，卸载器仍校验哈希。Windows fixture 使用真实 NSIS 格式；增加无引号兼容及不同目录、单边引号、附加参数、错误版本、错误哈希的拒绝回归。修改 fixture 后旧实现出现 3 项失败，修复后相关套件 15 项通过、1 项本机平台跳过。
- **Rust 偶发失败证据**：普通 CI run `44901252925` 的 Linux 与上述 Release 第 1 次执行的 macOS ARM，都在 `unknown_cleanup_does_not_notify_exit_before_successful_retry` 收到退出消息后立即要求通道断开的断言失败。`send` 唤醒接收者与发送回调返回后销毁 sender 是不同时间点，收到消息时 `try_recv` 仍可能是 `Empty`。
- **修复与自动化**：在测试中用回调返回屏障确定性保留 sender，先覆盖消息已收到但回调未返回的状态，再等待最终 `Disconnected`；另一个清理重试用例也等待最终通道关闭。旧断言在屏障下稳定失败，修复后定向运行 20 次通过。生产生命周期代码没有修改，清理成功前不得通知退出、通知只能发送一次的要求保留。
- **验证边界**：本机 fixture 回归不能证明 Windows 原生安装、ACL 与卸载成功。完整打包须使用包含修复与已审核版本说明的新提交；不得移动旧标签或把旧版本平台成功当作新版本验收。
