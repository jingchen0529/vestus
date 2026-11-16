# CfT Stable 157 升级

状态：本机更新完成，两轮本地验证通过；其他平台真实运行未验证。

目标：Chrome for Testing Stable **157.0.8103.78**，revision **1717349**。

旧本地随包内核：153.0.8010.12；应用版本不变，不提交/打包/发布。

## 要求

- 不通过Playwright升级到Beta；官方精确版本+架构下载，不以缓存mtime选内核。
- 仅现有四平台：Windows x64、Linux x64、macOS arm64/x64。
- 元数据/URL、ZIP路径与解压布局、native架构、实际browserVersion校验；每个下载与解压使用新空目录，脚本在目录外。
- 候选完整验证后才替换。保留153完整备份；下载/校验/复制/切换失败保留或恢复旧资源。不修改真实profile。
- 复用chromiumResourceDir/chromiumExecutable及现有Rust资源布局。
- 导入无副作用；离线平台/错误元数据/布局/链接/失败回滚测试。
- 新内核Browser.getVersion确认，两轮真实URL-only/托管guard门禁、退出重开和合成素材压力；非本机平台运行明确未验证。
- URL-only、代理/沙箱/GPU/SQLite边界保持。后续打包必须另行审核发布说明。

## 官方证据

`https://googlechromelabs.github.io/chrome-for-testing/157.0.8103.78.json` 返回目标版本/revision与四平台下载地址。mac-arm64 ZIP HEAD返回200，Content-Length196634479，2026-11-11更新。查询不代表本地安装已经完成。
