# 贡献指南

欢迎提交问题说明、文档修正和代码 PR。先说明要解决的问题、改动范围及验收方式；业务规则或不可逆取舍不明确时，先与维护者确认。

外部贡献者可以直接提交 GitHub Issue 或 PR，**无需先建立内部 `.scratch` 工单**。仓库内部的需求与实施记录仍遵循 [Issue tracker 约定](../docs/agents/issue-tracker.md)；领域文档见 [领域规则](../docs/agents/domain.md)，协作和发版要求以 [AGENTS.md](../AGENTS.md) 为准。

## 本地开发

- Python 3.11+；后端本地运行使用独立的开发数据库，配置步骤见 [快速开始](../README.md#快速开始)。不要连接生产库做测试或初始化。
- Node.js 22.22.2 为当前 CI/发布基线；Web 的 `engines` 最低要求为 Node >=22.13。管理端使用 `pnpm@11.1.0` 和 `web/pnpm-lock.yaml`，桌面端使用 npm 和 `desktop/package-lock.json`，不要混用包管理器或顺手重写锁文件。
- 桌面 Rust 工具链由 [rust-toolchain.toml](../desktop/src-tauri/rust-toolchain.toml) 固定为 1.97.1。先安装 rustup，并在 `desktop/src-tauri` 内运行 Rust 命令，确保读取该文件；还需对应平台的 Tauri 系统依赖。

以下命令从仓库根目录执行，按改动涉及的部分选择：

```sh
# 后端：建议先创建并激活独立 Python 虚拟环境
make install
make run

# 管理端：使用冻结锁文件安装
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev

# 桌面端：只启动开发模式，不生成版本化安装包
npm --prefix desktop ci
node desktop/scripts/prepare-chromium.mjs
npm --prefix desktop run desktop:dev
```

后端启动前在本地配置独立数据库和必要密钥，不将真实值写入 PR。Chromium 准备会下载对应平台的锁定浏览器；依赖安装或下载失败时记录原因，不把缺失依赖当作验证通过。

## 验证与 PR

先确定可复现的验收方式，再改实现。覆盖成功、失败、异常路径，以及兼容性、迁移与回滚影响；修复后至少再跑一轮同口径复测。

```sh
# 后端：ruff → mypy → import-linter → pytest
make check

# 管理端
pnpm --dir web test
pnpm --dir web build

# 桌面壳与 Rust：先构建壳，Rust 编译期会读取构建产物
npm --prefix desktop test
npm --prefix desktop run build
npm --prefix desktop run check:surfaces
(cd desktop/src-tauri && cargo fmt --check && cargo test --locked --lib)
```

这些是可运行的门禁，不代表本次改动已经通过。PR 中写明实际命令、环境和结果，列出失败原因及明确的“未验证”项目；纯文档改动可验证本地链接、命令与现行配置一致性，说明未运行业务测试。真实浏览器行为另按 [持久化验收](../docs/browser-persistence-testing.md) 验证，CI 或静态检查不能代替真实链路验收。共享测试数据库的用例串行执行，每轮前清理测试数据。

保持改动聚焦，不覆盖其他人的工作区文件。不要提交密钥、令牌、密码、Cookie、会话数据、浏览器 profile、客户数据或含敏感信息的日志和截图；安全问题按 [安全报告指南](SECURITY.md) 私密报告，不写入公开 Issue 或 PR。

## 打包与发布

版本化桌面打包与发布严格遵循 [AGENTS.md](../AGENTS.md) 和 [中文版本说明规则](../docs/releases/README.md)：核对上一发布 tag 以来的变化 → 编写并完整展示中文说明 → 获得用户明确批准 → 运行 `node desktop/scripts/check-release-notes.mjs <version>` → 将审阅后的代码与说明提交在同一提交 → 仅按授权推送新 tag 或启动手动构建。说明必须位于实际构建的同一 SHA 中；版本、环境或实质说明变更后要重新展示并确认。

版本说明需包含版本、目标环境与 API 地址、变化、安装、后端/迁移要求、实际验证及限制。PR 勾选项或 CI 通过不能证明用户已批准。普通 PR、合并或提交请求不授权打包、打 tag、发布或部署；不得移动历史 tag。手动 `Release` 也需版本及同提交的说明，但只生成 Artifacts，不创建 GitHub Release。
