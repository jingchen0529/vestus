# Windows Chromium ACL 修复与本地验证

日期：2026-11-16。

状态：修复和最终两轮本地验证完成；0.2.20 发布说明已获用户批准，修复代码、说明与台账一并提交并推送标签触发四平台构建。

基线：`451b3e196b3d0889bbc1c9fbcd618c149dbef447`（desktop-v0.2.19）。修复分支：`fix/windows-chromium-acl`。旧标签未移动，尚未生成 0.2.20 标签。

## 故障与修复

0.2.19 的 Windows 真实浏览器门禁日志确认沙箱无法读取随包 chrome.exe（Access denied 0x5），网络服务崩溃，首条地址采集超时。测试直接启动二进制，绕过生产安装器/运行时权限准备。该故障不能认定为客户素材页冻结的根因。

改动限于：

- `desktop/src-tauri/src/browser.rs`：抽出既有 Windows ACL 命令构造；生产仍保留同一组 SID/RX、Once 和原有 best-effort 行为。增加仅供测试使用的准备入口，canonical 路径限制到随包资源，递归检查原始资源根及后代，拒绝符号链接、Windows reparse point 和特殊文件。命令执行失败或非零退出直接返回错误并保留诊断。
- `desktop/src-tauri/src/cdp/control_tests.rs`：公共启动入口在 spawn 前执行权限准备。将登录、拦截和跳回业务页放在一个 renderer 任务内，独立检查锁定/释放、执行时间小于原 4 秒窗口；等待完整 4 秒加 200ms，确认取消后不误报。单独安静登录超时与 ConnectionLost 验证保留。
- `desktop/src-tauri/src/browser/persistence_tests.rs`：启动前独立执行同一权限准备，不依赖前一测试留下的 ACL。

未修改：生产代理、沙箱开关、Chromium 版本、安装器权限、CDP/托管生产实现、超时常量、发布门禁严格程度、后端与管理端运行代码。

## TDD 与审查

- 首个准备回归先失败（exit 101：bundled browser must prepare sandbox permissions），实现后通过。
- 审查发现正常 chrome.exe 旁的其他外链可能让递归 ACL 越界；新增回归先失败（exit 101：recursive ACL must not follow any resource link），资源树预检查后通过。
- 最终 5 项准备测试通过：准确参数与启动失败、成功/非零状态及诊断、外部路径排除、资源根/可执行链接处理、其他后代链接在调用命令前被拒绝。
- 两项只读审查完成，权限链接问题修复后复审关闭。Windows 真实编译、icacls 的 verbatim/UNC 路径及 reparse point 执行未在本机验证。

## 最终两轮结果

本机为 macOS ARM64，随包 Chrome/157.0.8103.78；真实测试使用新 profile 与 localhost，不接入用户浏览器、实际队列或客户账号。

| 检查 | 第一轮 | 第二轮 |
|---|---:|---:|
| 桌面 Node 测试 | 169 通过，0 失败 | 169 通过，0 失败 |
| 桌面 tsc / Vite build | 通过 | 通过 |
| 能力边界 | 通过 | 通过 |
| Rust 全目标串行回归 | 306 通过，0 失败，5 忽略；56.41s | 306 通过，0 失败，5 忽略；56.08s |
| 显式真实 Chromium 门禁 | 2 通过，0 失败，0 忽略；72.83s | 2 通过，0 失败，0 忽略；72.49s |

Rust 默认忽略的两个真实 CDP 用例已另行显式执行；其余真实持久化、跨版本升级、强杀/重开矩阵本轮未执行，不计为通过。格式与 git diff 检查通过。0.2.20 说明格式校验连续两次通过。

执行命令：

```sh
npm --prefix desktop test
npm --prefix desktop run build
npm --prefix desktop run check:surfaces
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1
VESTUS_CONTROL_CHROMIUM='<随包可执行文件绝对路径>' npm --prefix desktop run test:control
node desktop/scripts/check-release-notes.mjs 0.2.20
git diff --check
```

最终原始日志由工具结果保存：

- 完整两轮：`call_36e4768d2d23404592c7b13fe9ab5e72-stdout.log`。
- 显式真实门禁两轮：`call_a0b913ca8acf4d6e8b836777b8fd3ba3-stdout.log`。
- 日志目录：`/var/folders/rm/pnvmp2k51y9cl00w17w_ktnr0000gn/T/zcode-bash-VkFp6N/sess_2f68d202-e222-4c50-b947-bdadc2c5dbb8/`。

## 中途失败

最终修复后一次真实门禁在 self-healed login 取消验证失败。旧测试在 4 秒生产窗口内分别建立多个 CDP 驱动连接，无法保证自愈动作按时完成；调整为同一 renderer 任务。中间一次仍按登录态断言跳离后的 inert/opacity，实际正确释放为 false/空，修正独立锁定/释放快照。

曾短暂用 250ms 检查取消，最终审查认为不足以证明跨完整截止时间无误报，已恢复 4 秒加 200ms 并连续两轮通过。未放宽生产 LOGIN_SETTLE，没有删除或跳过失败测试。

## 发布与回滚边界

用户已授权修复并重新打包，按项目规则仍需批准最终 0.2.20 说明后，才提交发布变更和推送新标签。目标沿用 dev API `https://vestus-dev.quanyuos.com`，不移动 0.2.19 标签，不部署后端或迁移。

Windows 实际修复效果、四平台新构建、安装包安装、真实素材卡死与 GPU/内存问题均未验证。下一步由开发端的新构建确认两个 Windows 真实控制测试和持久化结果，不能把本机通过替代 Windows 验收。
