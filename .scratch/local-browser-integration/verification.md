# 本地浏览器优化提交与 main 整合验证

日期：2026-11-16。

## 范围与历史

用户授权本地提交及合并，不授权push、tag、打包、发布或删除旧分支。

- 整合前发布分支：`release/desktop-v0.2.18`，`16753f4aa6377b94c0ea6225686c5b2624ae6fd1`。
- 整合前main：`bac5ddf0ec8379928a1241b7ec0488814d7d19b1`。
- 新本地分支：`perf/browser-stability`。
- 浏览器优化提交：`16d3fc8`（perf(desktop): 精简地址采集并锁定 CfT 稳定版内核）。
- main的托管审计改动自动合并无冲突；发布分支原有3个独有提交全部保留，不rebase、不改原tag、不覆盖旧分支。
- 浏览器ZIP、完整二进制、备份和临时数据库不入Git；已提交的是脚本、代码、测试、文档及脱敏合成测量摘要。

## 验证口径

针对实际合并后的工作区，两轮完整串行回归。Python每个用例使用清理后的隔离SQLite fixture，无生产数据库/真实凭据/真实profile；共享测试不并行。

| 检查 | 第一轮 | 第二轮 |
|---|---:|---:|
| `npm --prefix desktop test` | 169通过、0失败 | 169通过、0失败 |
| desktop `tsc` / vite build | 通过 | 通过 |
| `npm --prefix desktop run check:surfaces` | 通过 | 通过 |
| `npm --prefix web test` | 127通过、0失败 | 127通过、0失败 |
| web build | 通过 | 通过 |
| `.venv/bin/python -m pytest -o addopts='' -q tests` | 491通过、1已有依赖警告 | 491通过、1已有依赖警告 |
| `cargo test --offline --locked --all-targets -- --test-threads=1` | 301通过、0失败、5显式忽略 | 301通过、0失败、5显式忽略 |
| 真实CfT157 `npm --prefix desktop run test:control` | 2通过、0失败、0忽略，74.45s | 2通过、0失败、0忽略，73.79s |

真实门禁使用当前随包 `157.0.8103.78`、全新profile和localhost页面，生命周期测试有窗口，地址/托管测试headless。Rust默认忽略的另外3项是真实持久化/跨版本升级/forcekill矩阵，本轮未运行，不计为通过；两个CDP忽略项已另行显式跑两轮。

`cargo fmt --check`、git staged/workingtree diff checks通过。新增调查Markdown的硬换行空格最初被staged diff check标记，已清理重检通过；活动投递文档的旧内核说明已修正。

## 保留的限制

- 客户Windows真实素材选择、驱动/GPU、安装及持久化链路未验证；本地整合不等于发布，也不宣称客户卡死已消失。
- 新地址采集与旧队列兼容已覆盖；历史队列继续按原内容补报，不清空历史。
- 本地CfT157完整二进制与旧153备份仍在Git忽略的资源/cache目录。其他机器须执行已提交的准备脚本获取精确版本。
- 调查记录内“未提交/未打包”描述的是各阶段当时状态；最终本地提交/整合结果以本记录和Git历史为准。
- 旧分支全部保留。远端未fetch、未push；origin跟踪信息只代表本地已有快照。

完成合并提交后，本地main通过 `--ff-only` 更新到已验证的整合分支，避免再产生未测试的第二次合并。
