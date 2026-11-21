# GitHub Actions 与发布配置

## 参考与本项目取舍

本次对照 [Winc `.github`](https://github.com/DEEIX-AI/Winc/tree/ed0d68ef4be4657867270ef5e5c84a1372ed9f8e/.github)，
固定来源提交为 `ed0d68ef4be4657867270ef5e5c84a1372ed9f8e`（2026-11-20）。实际读取了
`ci.yml`、`release.yml`、`release-prepare.yml`、`release-tag.yml`、三个分平台发布工作流、
`actions/build-setup/action.yml`，以及直接引用的 source/publish 脚本。

采用其职责分离、源码提交一致性、前置版本检查、原生平台矩阵、最小权限、超时、严格资产集合
与 SHA-256 校验的做法。Vestus 按职责保留 CI/Release，并新增仅手动触发的浏览器专项工作流；辅助逻辑使用
可本地测试的 Node 脚本。额外把第三方 Action 固定到上游核验的 commit SHA。

不照搬 Winc 的自动打 tag/dispatch、通用 Download 发布正文、终端专用打包、Arch/appcast 或
签名服务。Vestus 的中文发布说明与用户确认要求优先；Issue tracker 仍使用 `.scratch`，
不引入与其重复的 GitHub Issue/CLA 模板。源码读取不等同于参考工作流运行或签名链路已验收。

## CI

`workflows/ci.yml`：push 到 `master` 与 pull request 触发，无部署或安装包打包步骤。

| Job | 门禁 |
| --- | --- |
| workflows | 固定版本 actionlint 的 GitHub Actions 语义检查；工作流契约测试 |
| backend | ruff → mypy → import-linter → pytest；每个 fixture 使用独立 SQLite |
| web | 固定 pnpm、冻结安装 → Node 测试 → tsc/Vite build |
| desktop-shell | npm ci → Node 测试 → tsc/Vite build → surfaces |
| desktop-rust | Linux x86_64 / Windows x86_64 / macOS ARM64：Node 测试/build/surfaces、locked Rust 库测试；fmt 仅 Linux |

三平台 matrix 使用原生 runner、`fail-fast: false`，一个平台失败不取消其他平台的诊断；普通 CI 不准备真实
Chromium，也不打版本化安装包。独立 Linux shell job 保留，不能用其结果替代 matrix 的原生 Node/Rust 结果。

同 ref 的新 CI 取消旧 CI；每个 job 有超时。第三方 Actions 固定完整 SHA，checkout 不持久化
Git 凭据。Rust 编译缓存仅 `master` push 保存，PR 与 Release 只恢复；安装包已压缩，上传时不再压缩。
仓库保护/required checks 需要由维护者在 GitHub 设置，本地文件不等于已启用保护。

工具链：Node `22.22.2`；Web `web/package.json` 声明 `pnpm@11.1.0`（要求 Node >=22.13）；
桌面使用 npm 与 `desktop/package-lock.json`；Rust 由 `desktop/src-tauri/rust-toolchain.toml`
声明 `1.97.1`，CI 与 Release 均在该目录运行 rustup/cargo。不要只从仓库根执行带
`--manifest-path` 的 Cargo 命令并期待子目录工具链文件自动生效。

## Release

`workflows/release.yml` 保留四目标：Windows x86_64、macOS ARM64、macOS Intel、Linux x86_64。
仅 push `desktop-v<x.y.z>` 发布 GitHub Release。`workflow_dispatch` 必须填写 `version`，
即使手动选择一个 tag，也只生成 Artifacts，不发布。

1. 先按根 `AGENTS.md` 审阅上一 release tag 以来的变化、写中文说明、完整展示并获得明确确认。
2. 将代码与 `docs/releases/desktop-v<版本>.md` 放进同一提交，之后仅按授权打包或推送新 tag。
3. preflight 检查辅助脚本/工作流契约、版本说明与构建 API。一项失败，四平台不会启动。
4. 所有 job checkout 触发 SHA；每个平台再次校验 API 与说明，然后 stamp version、准备 Chromium、
   测试、原生打包、收集安装包，再对最终安装包执行原生验收。验收失败阻断该平台上传与发布。
5. 全平台成功后，唯一拥有 `contents: write` 的 publish job 下载工件、再次验证并使用同提交中的
   中文说明作为 Release 正文。发布不取消进行中的同 ref 运行。

CI 校验文档和配置，不证明用户在对话中已批准。不得自动移动历史 tag，不得把重跑当成允许覆盖
正式发布的授权。当前 GitHub Release 创建仍非事务性：上传失败可能留下部分资产，应先核验现状
再按新的明确授权处理，不盲目重跑覆盖。

### API 配置与输入

仓库 Secret 名称保持 `VESTUS_API_BASE_URL`；手动输入 `api_base_url` 可覆盖。这里只记录名称，
不读取、保存或展示真实值。`prepare-release-api.mjs` 在写 `GITHUB_ENV` 前完成事件/版本、URL
及发布说明一致性校验：拒绝换行/控制字符、凭据、查询参数、片段、无效地址。

正式 tag push 必须配置真实 HTTPS 地址，拒绝占位或本机地址。手动构建可显式选择 HTTP 测试
环境，并设置一次性 `VESTUS_ALLOW_INSECURE_API=1`；未配置则保留 `.invalid` 占位，但发布说明
必须如实记录同一地址，产物无法登录。API 错误/警告不回显原始输入或 Secret。API 不作为 job
output 跨 job 传递；每个构建 job 独立验证。

### 工件

必需集合（每种扩展名恰好一个）：

- `Vestus-<版本>-windows-x86_64.exe`
- `Vestus-<版本>-macos-aarch64.dmg`
- `Vestus-<版本>-macos-x86_64.dmg`
- `Vestus-<版本>-linux-x86_64.deb` 和 `.AppImage`

`release-assets.mjs collect` 拒绝缺包、同扩展重名和错误平台安装包，不跟随 bundle 内的符号链接；
目录路径不能经由符号链接。它输出每平台的 `SHA256SUMS-<平台>.txt`。publish 用 `verify`
拒绝所有符号链接与未知文件，检查全部预期文件与哈希，再生成统一
`SHA256SUMS.txt`。这些校验不等同于签名、公证或安装启动验收。

安装包 Artifacts 与浏览器诊断保留 14 天。Windows persistence 当前仍非阻断（entry document
not ready 尚未通过验收）；须查看该步骤结果与诊断，不能把 Release 成功当成它已通过。

### 成品验收与报告

`verify-installers.mjs <version> <label> <assetsDir> <reportDir>` 检查 collect 之后的最终包，写独立
`desktop/test-results/package-acceptance/<label>.json`，以 `package-acceptance-<label>` 上传并保留 14 天。
失败也保存检查/清理结果并非零退出，报告不进入严格限制资产集合的 `release-assets/`。

- Windows：仅显式 disposable hosted runner，在本次临时目录静默安装/卸载，检查版本、主程序架构、
  随包 Chromium 和沙箱 RX 权限。不提权、不卸载既有安装、不修改 PATH；注册表/快捷方式副作用只允许在
  可销毁 runner 中发生。缺 WebView2 的环境不自动下载安装 runtime。
- macOS：只读挂载最终 DMG，核验 plist 版本/identifier、实际应用架构与 Chromium 资源，检查存在的签名，
  finally 只 detach 本次 device；平台配置同时保留 app，作为签名后 executable 的同构建哈希对照源。
  unsigned/ad-hoc 不等于 Developer ID、公证或 Gatekeeper 验收。
- Linux：无 root 提取 deb，受控 runner 提取 AppImage，检查 metadata/desktop/ELF/资源。不运行维护脚本、
  不安装系统服务；AppImage extraction 会执行它的 runtime，不能描述为纯静态解析。

这些是包内容与安装集成检查，GUI 启动、登录和业务导航仍明确 `not-run`。fixture 自测通过不表示真实
NSIS/DMG/deb/AppImage 已在平台上验收，实际结果必须查看每次 runner 的报告。

## 协作与私密安全报告

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)，公开 PR 使用
[pull_request_template.md](pull_request_template.md)。内部 `.scratch` 规范不要求外部贡献者先取得内部工单。
截至 2026-11-20，GitHub 私密报告只读核验 `enabled: false`；维护者需在 Settings 启用并核验入口。
不增加 CLA、虚构许可证或维护 SLA；PR 勾选不能代替发布说明展示与明确批准。

## 手动浏览器专项回归

`workflows/browser-regression.yml` 只有 `workflow_dispatch`，可选 Linux、Windows、macOS ARM64，
运行 control、persistence 和 `test:material-smoke`。不定时、不使用业务凭据、不打安装包、不 stamp 版本或发布。
运行前须将 workflow/脚本提交并按授权推送到所选远程 ref；本机未提交文件不能被 Actions 执行。

素材 smoke 使用独有临时浏览器/profile、127.0.0.1 合成分页页面和已有 30 轮/31 样本采集测试，检查实际分页
变化、超时与清理。报告明确 `synthetic-smoke`、`memoryAcceptance: false`；它不代表生产启动路径、真实
素材平台/代理/登录或内存泄漏阈值已验收。成功与失败均仅上传报告，不上传 profile/Cookie/浏览器资源目录。
真实页面 A/B 仍使用原 `test:material`，需要操作者明确提供授权页面、已运行浏览器及参数。

```bash
npm --prefix desktop run test:material-smoke
# 或已存在的受控 Chromium 路径；不下载未知浏览器版本
node desktop/scripts/test-browser-material-smoke.mjs --chromium /absolute/path/to/chrome --timeout-ms 300000
```

持久化升级按 [双版本验收指南](../docs/browser-persistence-testing.md#升级与回滚) 手动提供两份完整浏览器目录，
当前 prepare 固定 Chromium 版本，不支持随意传入版本号；升级回归不作为默认 Release 门禁。

## 本地验证与维护

在项目根运行（不触发打包或发布）：

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
node --test .github/scripts/*.test.mjs
node --test desktop/scripts/check-release-notes.test.mjs desktop/scripts/prepare-release-api.test.mjs desktop/scripts/release-assets.test.mjs
pnpm --dir web test
pnpm --dir web build
npm --prefix desktop test
npm --prefix desktop run build
npm --prefix desktop run check:surfaces
(cd desktop/src-tauri && cargo fmt --check && cargo test --locked --lib)
```

`dependabot.yml` 每周检查 GitHub Actions、Web 和桌面 npm/pnpm 依赖，最多各 5 个 PR，不自动合并。
升级 Action 时核验上游 tag 的最终 **commit**（annotated tag 必须解引用），同步 SHA 注释并运行
actionlint 与契约测试。pnpm/Rust/Node 升级先验证冻结锁文件、全部门禁和相关原生平台；不要把
工具升级与发版混成未经审阅的一次操作。Python 依赖仍用范围约束，尚非完全锁定构建。

服务器沿用 [Linux 手动部署文档](../docs/deploy-linux.md)，本工作流不持有 SSH/数据库凭据，不自动
执行数据库迁移或服务器更新。配置回滚恢复本次文件即可；已经发布的资产/数据库迁移不能靠 Git
回滚自动恢复，须另行评估和授权。
