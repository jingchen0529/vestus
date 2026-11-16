# 地址专用采集：实现与验证

日期：2026-11-16。基线：16753f4aa6377b94c0ea6225686c5b2624ae6fd1。

状态：代码完成，完整 Rust 与真实 Chromium 门禁均完成最终两轮同口径复测。

范围：不提交、推送、打包或发布；不修改生产数据或用户 profile。

## 实际改动

- `desktop/src-tauri/src/cdp.rs`：删除活动采集 JS、Runtime.enable、addBinding/bindingCalled 与表单 payload 解析。直接用 Page/Target 事件记录地址及原有脱敏 query；保留 advid。
- 首次接管只播种一次 frame tree；旧回执不能覆盖新导航；SPA 只接受主 frame。播种前的多次 SPA 按顺序保留，包括随后发生完整导航的情况，不把 iframe 路由记为标签页访问。
- 保留 Page订阅、托管固定 guard、Runtime.runIfWaitingForDebugger、worker恢复后detach及单连接模型。普通页面不装采集或guard脚本；托管登录页的交互拦截只是安全防护，不采表单。
- `desktop/src-tauri/src/managed_cdp.rs`：登录页超时由deadline驱动，不依赖Runtime消息/采集心跳；就绪的跳离/关闭/断连消息先于超时处理，显式logout仍立即失效；ConnectionLost在退出时一次通知。
- `desktop/src-tauri/src/activity.rs`：新live事件入队前投影到地址、参数和访问元数据，拒绝无visit的旧交互事件。新序列化省略计数/停留/快照字段，旧staged与ready保留原数据、批次ID、owner和确认逻辑。
- `desktop/scripts/check-surface-boundaries*.mjs`：唯一文档脚本是托管固定guard；禁止Runtime订阅/绑定，覆盖实际collect_events helper。
- `desktop/scripts/test-browser-control*.mjs`：门禁必须同时执行且通过两个命名真实浏览器测试，不能用空测试/跳过/仅数量模拟通过。
- 新 `desktop/src-tauri/src/cdp/stream_tests.rs`，扩展 `cdp/control_tests.rs`、`managed_cdp/tests.rs`、后端v2测试和管理页显示测试。
- `README.md`、`docs/browser-activity-delivery.md`、`docs/architecture.md`：更新新采集边界、历史兼容与验证命令。

未修改：`activity_outbox.rs`、代理/直连/Chromium生产启动参数、Cargo依赖和锁、后端生产schema/服务、数据库迁移。SQLite FULL、容量/回滚和ACK隔离不变。

## 验证结果

| 检查 | 执行命令 | 结果 |
|---|---|---|
| 桌面完整单测 | `npm --prefix desktop test` | 最终两轮各157通过，0失败 |
| 桌面类型检查和构建 | `npm --prefix desktop run build` | 两轮tsc+vite通过 |
| 安全静态边界 | `npm --prefix desktop run check:surfaces` | 两轮及最后复测通过 |
| 管理端完整单测和构建 | `npm --prefix web test`、`npm --prefix web run build` | 127通过，构建通过 |
| 管理页相关复测 | `node --test web/test/admin-flows.test.mjs` | 多轮各38通过，构建复测通过 |
| 后端完整回归 | `.venv/bin/python -m pytest -o addopts='' -q tests` | 488通过，0失败，1个已有依赖弃用警告 |
| 后端协议相关复测 | browser_activity_api/v2、activity_identity_snapshot、browser_activity_service、advertiser_accounts、advertiser_identity | 多轮通过，最后91通过，0失败 |
| Rust完整回归 | `cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- --test-threads=1` | 最终两轮各301通过、0失败、5显式忽略；二进制目标0测试 |
| 格式与差异 | `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check`、`git diff --check` | 通过 |
| 修改Python测试lint | `.venv/bin/python -m ruff check tests/api/test_browser_activity_v2.py` | 修复导入顺序后通过 |

完整Rust默认忽略的5项：2项真实CDP门禁（另行显式执行），已有force-kill/rapid-reopen、持久化矩阵、跨Chromium版本升级矩阵。本次未运行后三项，不将其计为成功。

真实门禁命令：

```sh
VESTUS_CONTROL_CHROMIUM='<随包可执行文件绝对路径>' npm --prefix desktop run test:control
```

项目随包Chrome/153.0.8010.12，macOS arm64，全新profile、localhost页面；不接入用户浏览器。生命周期测试仍有窗口，采集/托管行为使用headless隔离fixture（不是客户Windows有窗口验收）。新测试覆盖：初始地址无重复、常规导航、SPA、iframe排除、popup/newtab、无活动binding、勾选/input/submit/scroll后61秒零报告、普通登录无guard、托管guard阻止交互、跳离取消deadline、安静登录一次Expired与关闭一次ConnectionLost。

最终两轮每轮两项通过、0失败、0忽略，耗时74.13秒和73.02秒；整个门禁命令退出0。结果文件位于 `desktop/test-results/browser-control/control.json`（末轮），两轮完整输出另保存在本报告相邻的 `evidence/real-browser-two-rounds.log`。

## TDD与审查修复

- 旧binding能产出表单报告、新live落盘含交互字段、无用Runtime订阅可通过边界：各先失败后通过。
- 首次播种前SPA被旧tree覆盖、多次SPA被覆盖、完整导航清空早期SPA：逐项生产collect-stream失败后修复通过，保留advid增量与主frame过滤。
- 用SchedulingGate只延迟生产collect Future，localhost服务器在deadline前发出跳离/detach/Close，超时后再恢复：修复前误报Expired（exit101）；reader优先+独立deadline判断后，三种情况全部通过（exit0）。
- Standards审查发现collect_events不在静态扫描范围：加入实际helper和负例，RED/GREEN确认。
- Spec审查的超时优先级、两条SPA丢失路径均已修复并复审，没有剩余阻断；不代表客户环境已验收。

## 过程中的失败如实记录

- 两个新增后端测试最初误断言明细含advertiserId，实际接口无此字段（KeyError）；改为现有advid导出接口和urlParams验证后通过，未改后端生产接口。
- 并行实现中几次Rust中间编译/格式失败，完整代码与格式收敛后重跑通过；未将中间状态作为交付结果。
- 早期真实测试的checkbox期望未包括原生input、Browser.close后的socket reset期望错误，修正测试并验证进程树退出后通过。
- 有窗口采集门禁一轮通过、下一轮61秒后目标消失（No target with given id found），不能确认原因，未计为稳定验收。采集fixture改为headless避免与桌面窗口交互互相影响，产品启动参数未改；最终两轮以新的同口径结果为准。
- ruff导入顺序报错修复后通过。

## 限制、回滚与下一步

- 首次frame tree前暂存最多64条候选，溢出移除最早并一次无URL诊断；极端情况下可能漏记，不是完整访问录像。
- 持续就绪CDP流量可延迟reader优先的超时通知，目前没有Runtime高频订阅；异常事件洪泛限流未验证/未实施。
- 已加载的初始托管文档在bootstrap导航与guard安装之间的继承时序风险未扩大修改；新target/popup的放行前guard验证与之不同。
- 客户Windows真实素材选择、GPU/驱动、内存与网络根因及优化后的冻结消失均未验证。未默认禁GPU或降低安全/持久性。
- 旧队列含历史交互数据会按原内容补报，不等于删除既有收集内容。新记录格式稀疏，降级到不支持此格式的旧桌面程序可能暂时不能消费新staged；队列保留，重新升级可继续补报，勿清库掩盖。
- 没有版本stamp、commit、push、tag、打包或发布。后续如要求打包，另按项目规则准备并审核发布说明。
