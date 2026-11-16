# 桌面端浏览器点击卡顿分析

日期：2026-11-16

状态：本地两轮验证完成；客户平台真实链路未验证。

范围：只读业务代码，在全新临时目录和 Chromium profile 中做实验；不读取凭据、真实 profile 或客户活动队列，不修改业务实现、不打包、不发布。

## 1. 结论

**目前没有证据把客户的明显卡顿定责为采集脚本或 SQLite。上一轮把几个性能嫌疑表述得过重，需要修正。**

本机随包 Chrome for Testing 中，页面点击计数、一般表单采集、托管业务页防护监听的开销很小；新页面 CDP 接管不是每次同页点击都发生。活动队列确有随积压增长的容量扫描开销，但即使约 116MiB payload 的重负载测试，也没有出现单次写入数秒停顿。

当前建议按症状分流：

1. **按钮立即变化/显示 loading，但内容很久不回来**：优先查页面请求的代理/直连路由、建连和 TTFB。源码存在秒级等待路径，真实代理质量尚未验证。
2. **按钮、输入、滚动和动画本身都卡**：优先查 Chromium 页面主线程、CPU/内存/磁盘及 GPU。`Runtime.enable` 的额外 console 事件开销已实测，是一个可控放大因素，但不是已确认的客户根因。
3. **新标签或弹窗特别慢，同页点击正常**：查新 target 接管延迟；本地放行回执 11–16ms，不代表客户机繁忙时的尾延迟。
4. **越用越卡且活动队列积压**：查上报可达性及队列规模；容量全表扫描是已确认的优化候选，不能仅凭队列文件大就断言它造成页面卡顿。

## 2. 修正上一轮判断

- 浏览器是独立的随包 Chromium 进程，不是 Tauri 内嵌 WebView。Tauri 的 Windows 清单不应直接归因到 Chromium 页面点击。
- `waitForDebuggerOnStart` 用于新 target 接管，不是每次普通同页点击都暂停。两轮连续 100 次同页点击均未产生新接管。
- 安装命令按顺序发送，但不是每条都等待回执后再发送下一条：`desktop/src-tauri/src/cdp.rs:353-379`。不能把六条命令当六次串行回执等待。
- 点击是 1000ms 窗口内聚合，不是每次点击都单独写库：`cdp.rs:182-199`。这是窗口聚合，不是不断重置定时器的标准 debounce。
- `wake.notify_one()` 在 capture 接收循环结束后，不是每次落盘后：`desktop/src-tauri/src/activity.rs:361-388`。
- `stage()` 在 `spawn_blocking` 中执行：`activity.rs:379-381`。不能把它说成直接同步占满四个 Tokio 网络 worker；它仍可能通过磁盘、CPU 和跨连接写锁造成间接竞争。
- 全表容量聚合不等于每次物理读取全部文件，操作系统/SQLite 缓存会影响耗时。
- SQLite WAL 的 `synchronous=NORMAL` 与 `FULL` 的断电持久性不同。不能把改成 NORMAL 推荐为无风险、无损优化。
- “异步代理实现看起来正常”不能排除上游代理、DNS、TLS、平台响应或混合路由的实际延迟。

## 3. 页面采集：两轮实际浏览器微基准

环境：macOS arm64；项目随包 `Chrome/153.0.8010.12`；全新 headless profile；localhost 静态 fixture。直接提取并执行未修改的 `COLLECTOR_SCRIPT`。报告 binding 替换为本地 stub，本项仅测事件处理与采集计算，不含真实 CDP 发送、Rust 聚合、网络或绘制。

每项预热 50 次，采样 100 组，每组 5 次事件；两轮分别新建页面。下表为每次 input 处理的 P95：

| 场景 | 第1轮 | 第2轮 |
|---|---:|---:|
| 10 个字段，独立 form | 0.04ms | 0.04ms |
| 50 个字段 | 0.10ms | 0.10ms |
| 500 个字段 | 0.10ms | 0.12ms |
| 5000 个字段 | 0.64ms | 0.46ms |
| 无 form，约 5000 DOM 节点 | 0.40ms | 0.36ms |
| 无 form，约 50000 DOM 节点 | 1.40ms | 1.26ms |
| 1000 个同名字段 | 2.02ms | 1.38ms |
| 5000 字段，多数被敏感键过滤 | 0.98ms | 0.88ms |

普通 click 计数的 P95 低于该实验计时分辨率，**不是数学意义上的零开销**。两轮报告计数和字段上限断言全部通过：550 clicks、1100 input/change、550 submits，快照字段不超过 50。

原因解释：字段循环在收集到 50 个不同字段后会提前结束，上一轮把字段序列化成本描述为总是逐个处理全部字段不准确；`querySelectorAll` 仍会先建立匹配列表。同名/被过滤字段可走更长循环。

引用：`desktop/src-tauri/src/cdp.rs:122-156`、`:188-200`。

**判定：存在可优化的同步 input/change 扫描，但本机测量不支持其单独解释明显的数秒点击停顿。低配 Windows、真实广告页面布局与长任务未验证。合成事件耗时不是 INP。**

## 4. CDP 事件与暂停：两轮实测

### Runtime.enable

实际通过 CDP 验证 `Runtime.addBinding`，并执行 2000 次简单 console 输出：

| 场景 | 第1轮 console 循环 | 第2轮 | console CDP 事件 |
|---|---:|---:|---:|
| 不开启 Runtime.enable | 6.2ms | 8.2ms | 0 |
| 开启 Runtime.enable | 21.4ms | 31.9ms | 每轮2000条 |

两种模式均成功收到 1 条 `Runtime.bindingCalled`。这证明在本机这版随包 Chromium 的测试条件下，binding 可在不启用 Runtime 事件流时工作；不构成全部 Windows/macOS 随包版本、首文档注入、跨上下文生命周期及托管防护兼容性验收。

产品每条 CDP 文本消息先解析完整 JSON，即使最终不消费 console 内容：`desktop/src-tauri/src/cdp.rs:798`、`:860-919`。

**判定：不消费的 console 事件是一项已证实的额外负载。可以评估精简 Runtime 订阅，但上线前必须回归采集、首文档、弹窗、导航、托管失效检测与连接关闭，不能直接关闭后就宣称解决了客户问题。**

### 新 target 接管

模拟当前安装顺序，六条命令连续发送，不逐条等待回执：

- 第1轮：安装/放行全部回执完成 11.03ms；创建页面至可用 32.13ms。
- 第2轮：回执完成 15.79ms；创建页面至可用 37.57ms。
- 两轮每 100 次普通同页点击，新接管次数均为 0。

创建至可用耗时包含 localhost 页面加载和测试脚本轮询，不是纯 CDP 暂停时长。源码也已有非 page target 显式恢复再 detach 的处理与回归测试：`cdp.rs:831-857`。

## 5. 托管登录防护脚本

上一轮遗漏了 `desktop/src-tauri/src/managed_cdp/login_guard.js`：

- 同平台业务页保留多个 capture 监听和一个 DOM MutationObserver；事件执行 URL 判断。MutationObserver 的回调不遍历整棵 DOM，只调用 `sync()` 检查路由。
- `/login` 及子路径才会设置根节点 `inert`、隐藏并禁止交互；正常业务页不会持续锁住点击。
- 两轮每次 pointerdown/mousedown/pointerup/mouseup/click 五事件序列的 P95：仅采集时 0.003/0.002ms；加防护后 0.007/0.008ms。
- 两轮路由到测试 `/login` 后，`inert=true`、click 被阻止；回业务页后样式与 `inert` 恢复。

测试只把固定防护路由 origin 替换为 localhost，其余脚本不变；MutationObserver 在真实 SPA 的频率与性能尚未测量。未把正常防护动作误认为卡顿。

引用：`login_guard.js:9-13`、`:28-64`、`:84-90`；`managed_cdp.rs:710-744`。

## 6. 活动队列：直接调用真实 Rust 实现的两轮微基准

使用全新临时 Cargo 工程，通过 `#[path]` 引用现有未修改 `activity_outbox.rs`，离线构建；依赖 SQLite 为 rusqlite bundled。每轮独立新数据库；0/1000/5000/9900 行，768B/12KiB payload，各100次。保留 `synchronous=FULL`，不改业务持久性。

关键结果：

- 小 payload、小队列：单次写入通常约 0.7ms 中位数。
- 9900 行 × 768B：第1轮 P95 6.02ms。
- 9900 行 × 12KiB：第1轮 P50/P95/max 为 21.51/23.36/24.64ms；第2轮为 23.10/39.50/73.04ms（每次最后连接关闭场景）。
- 接近满容量的大 payload 场景约 116MiB 原始 payload；同构分解显示容量检查为主要成本，而非简单归结为 FULL fsync。
- 两轮行容量/字节容量满时失败回滚、重开、再次失败验证通过，原有记录/内容/序列未变。
- 队列单元测试两轮各11/11通过。

源码：每次 stage 新连接、INSERT、全表 `COUNT/SUM`、commit：`desktop/src-tauri/src/activity_outbox.rs:87-108`、`:215-223`。

限制：不是 Chromium → Rust → 实际后端完整链路；未清操作系统缓存；未测低配客户 Windows、杀毒软件扫描、机械盘、多个桌面实例/会话同时写。无界 channel 在生产速度超过持久化速度时存在积压风险，但普通点击已聚合，不能据此认定客户已触发。

**判定：容量全表扫描是合理的优化方向；应优先在保持 FULL 和容量/回滚语义的条件下考虑增量容量统计、连接复用、受控批量写入。任何批量化都须明确崩溃窗口与关闭排空，不作为本轮分析中已完成的修复。**

## 7. 代理与直连：能产生秒级等待的路径

### 已确认的代码行为

- HTTPS 建立 CONNECT 后为双向字节透传，无 TLS 解密。TLS/ALPN/HTTP2 由浏览器和目标站点协商；不能用普通 HTTP 的 `Connection: close` 解释所有 HTTPS 操作慢：`desktop/src-tauri/src/adapter.rs:189-223`。
- 新上游连接超时10秒，CONNECT 响应等待超时15秒。两阶段顺序执行，但10/15秒是上限，不是每次固定延迟：`upstream.rs:22-23`、`:84-129`。
- 普通明文 HTTP 每请求新连接并强制 close：`upstream.rs:155-156`；是否为客户慢资源，未验证。
- 直连先 DNS，再逐个尝试可用 IP，每个连接候选最多10秒；没有地址间并发竞速及一轮建连总截止时间：`desktop/src-tauri/src/bypass.rs:152-185`。当 DNS 首选地址不可达时，可能先等超时再尝试可用地址。
- 代理/直连失败固定返回502，认证失败407，不切换路由绕过代理；测试覆盖正确性不等于真实性能。

### 必须结合真实页面确认

主文档、接口、JS/CSS、图片/CDN 可能命中不同路由。页面 HTML 打得快，不代表点击按钮用到的接口/资源走得快。需要脱敏证据：host、路径去掉 query、路由类别、建连/TTFB/响应耗时及状态码；不导出 Cookie、Authorization、表单值或未经清洗 HAR。

如果真实证据指向首个 IP 超时，可设计保留地址安全过滤的多地址连接竞速与总截止时间；如果是代理 TTFB/丢包，应查线路而非调整采集持久性。

## 8. 首轮真实定位的验收方式

需要客户环境才能完成，但不把功能自测转交客户。下一阶段宜建立不含敏感数据的诊断，再由开发端分析：

| 检查 | 成功证据 | 异常/失败证据 |
|---|---|---|
| 同页按钮纯交互 vs 需请求按钮 | 事件处理/绘制快且请求快 | 长任务或请求pending/TTFB慢，明确二者区别 |
| 受控路由下同一页面/同一操作重复至少两轮 | 路由相同、耗时可重复 | IP候选超时、407/502、网络失败不得混成成功 |
| 页面长任务/渲染/GPU | Chromium资源与耗时匹配 | CPU满载、内存压力、软件渲染/远程环境标明 |
| 活动队列 | 只查计数、字节与持久化耗时 | 上报退避、队列增长、写锁竞争；不读取业务payload |
| 优化前后回归 | 首文档、弹窗、计数、脱敏、防护、失败回滚通过 | 回归失败即停止交付，不降低安全/持久性来换快 |

未授权更换实际路由、使用生产凭据或向外部服务发送内容。本轮没有执行这些操作。

## 9. 执行记录与产物

主要命令：

```sh
node /tmp/vestus-browser-analysis.yiSRs8/collector-benchmark.mjs <cdp.rs> <bundled-chromium> /tmp/vestus-browser-analysis.yiSRs8
node /tmp/vestus-browser-analysis.yiSRs8/cdp-guard-benchmark.mjs <cdp.rs> <login_guard.js> <bundled-chromium> /tmp/vestus-browser-analysis.yiSRs8
python3 -I /tmp/vestus-browser-analysis.yiSRs8/summarize-collector.py
python3 -I /tmp/vestus-browser-analysis.yiSRs8/validate-cdp.py
cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --lib cdp:: -- --test-threads=1
cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --lib adapter:: -- --test-threads=1
```

- 页面和 CDP 微基准各自内置两轮，退出码0，数据断言通过；本次创建的浏览器进程已关闭。
- CDP/托管相关测试两轮各58通过、0失败、1忽略（另一个需显式启动真实窗口的既有测试未运行，未伪称通过）。
- 本地代理测试两轮各10通过、0失败，包括 CONNECT透传、407/502、无路由兜底、停机断连。
- Chrome DevTools MCP 连接失败：已有工具 profile 实例占用，未关闭/删除已有实例；改用独立子进程和profile。
- 曾有一次临时 Python摘要命令括号错误（SyntaxError，退出1），改用独立脚本后通过；不涉及产品代码。
- CDP代理子代理因提供方限流停止，相关源码复核和浏览器实验由主线程完成；没有把未完成的子代理结果当证据。

产物：

- 浏览器实验脚本/原始 JSON：`/tmp/vestus-browser-analysis.yiSRs8/`。
- 队列实验脚本：`/private/tmp/vestus-outbox-bench.1QjA5ToJ/`；结果在 `results/summary.json`、`results/summary.txt` 及两轮原始 JSON。
- 脱敏测量结果已复制到本报告相邻的 `evidence/collector-results.json`、`evidence/cdp-guard-results.json`、`evidence/outbox-summary.json`、`evidence/outbox-summary.txt`，避免只依赖临时文件。
- 队列微基准保留的合成测试数据库约2.9GiB，独立编译目录约104MiB，位于上述临时目录。未删除，不包含客户数据；需要释放空间时可在确认范围后清理这些临时实验文件。最终结果仍与报告结论一致，没有发现单次秒级写入。
- 仓库仅新增本分析报告及脱敏实验摘要，不修改业务代码。无生产/用户数据影响，无发布或提交；无需业务回滚。

**未验证：客户桌面版本与操作系统、卡顿平台与具体操作、客户代理/直连路由和网络时序、真实页面INP/长任务/GPU、客户磁盘和队列、优化后的真实业务收益。**
