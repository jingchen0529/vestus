# Windows Chromium 测试沙箱权限准备

状态：实施方案与 0.2.20 说明均已获批准；修复、本地验证和提交完成，四平台构建结果以远端实际运行为准。

基线：desktop-v0.2.19 / 451b3e196b3d0889bbc1c9fbcd618c149dbef447。

## 故障证据

GitHub run 43831648713 的 Windows 真实控制测试失败：Chrome/157.0.8103.78 能响应 Browser.getVersion，但 sandbox 无法访问随包 chrome.exe（Access denied 0x5），随后 network service 崩溃，首条地址报告超时。macOS 双架构与 Linux 构建成功，Publish skipped，Windows 无安装包。该证据不等于客户素材选择卡死已确诊。

## 约定

1. 复用生产现有绝对 SystemRoot/System32/icacls.exe 命令，三个既有 SID 仅授予 RX、继承及递归参数，保留沙箱与生产启动行为。
2. 新检查入口仅用于测试：真实路径限定本仓库 resources/chromium，外部浏览器不修改权限；命令执行失败/非零退出须在启动前报错并保留输出诊断。
3. 控制 fixture 的公共启动入口（有窗口/headless）及持久化 fixture 均显式准备，不能依赖测试顺序。
4. 非 Windows 不运行权限命令。保留严格真实门禁，不 skip、不加 no-sandbox、不延长导航等待掩盖失败。
5. 先建立失败回归，再实现，完成两轮相关与完整 Rust/桌面回归、真实 Chromium 控制验证和只读审查。本机为 macOS，Windows 真执行结果未验证。
6. 用户要求修复后重新打包。准备 0.2.20 中文说明，目标沿用 dev / https://vestus-dev.quanyuos.com，不移动0.2.19标签；说明展示批准后才提交、推送新标签/打包，不部署后端。
