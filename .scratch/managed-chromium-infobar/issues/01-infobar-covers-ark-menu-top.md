# 01: Chrome for Testing 提示条挤压页面视口，方舟顶部菜单被压下/疑似错位

Status: open（分析完成，待实测定性 + 选修复方向）

## 现象

客户机器（Windows）上，桌面端托管启动的方舟窗口（`agent.oceanengine.com/arksit/homepage`）里，
地址栏下方出现一条常驻横条：

> Chrome 测试版 v153.0.8010.12 仅适用于自动测试。若要进行常规浏览，请使用可自动更新的标准版 Chrome。

横条下方、方舟欢迎语上方有一条灰白空带——方舟页面顶部菜单条应在的位置，菜单顶部内容看起来被"挡住"。
现场截图为拍屏（2026-11-04，飞书会话），低对比度，无法从截图单独判定菜单是"被压下去"还是"渲染空白"。

## 定性

1. **这条横条不是网页内容，也不是 Vestus 注入的 UI**，而是 Chrome for Testing（CFoT）
   构建自带的内置提示条（infobar），由浏览器窗口自身渲染，位于地址栏和网页视口之间。
   页面 JS/CSS 碰不到它。
2. **来源**：桌面端打包的浏览器是 Playwright 下载的 Chromium——新版 Playwright 的
   chromium 实际是 CFoT 构建（见 `desktop/scripts/chromium-resource.mjs` 注释：
   macOS 下 `.app` 名为 "Google Chrome for Testing.app"）。截图版本号与文案即该构建特征。
3. **启动参数未处理**：`desktop/src-tauri/src/browser.rs` 的 `chromium_arguments()`
   只有 `--remote-debugging-port=0`、`--hide-crash-restore-bubble`、代理/沙箱开关等，
   没有任何针对该提示条的参数，代码中亦无 infobar 相关处理。

## 机制

- infobar **不是盖在页面上的浮层**，而是把网页视口整体下压。桌面端用
  `--window-position` / `--window-size` 显式下发外框几何（browser.rs，见
  `FALLBACK_WINDOW` 与 `WindowGeometry`），外框高度固定；tab 条 + 地址栏 + infobar
  都从同一高度里扣，**页面可用高度直接少约 40px（随 DPI 缩放）**。
- CFoT 这条提示从窗口创建第一帧就常驻（不像 `--enable-automation` 那条中途弹出），
  视口"从头就矮一截"，布局稳定，不会中途跳。
- 托管链路为 `about:blank → Rust 注 Cookie → 导航到业务 URL`
  （`docs/design/2026-11-02-巨量方舟托管登录设计.md`）。CDP resize 时机与页面首帧
  之间存在竞态的可能性，是"菜单空白"的候选解释之一。

## 影响面

| 影响点 | 程度 |
| --- | --- |
| 页面视口高度少 ~40px，方舟顶部菜单下移/可能错位 | 确定存在，本 issue 主诉 |
| 客户看到"仅适用于自动测试"字样，暴露自动化痕迹 | 确定存在，观感/风控观感问题 |
| CDP 采集、Cookie 注入等功能 | 不受影响（CDP 截图只看网页视口，拍不到浏览器 chrome） |
| 菜单空白是"压下去"还是"渲染坏了" | 待实测区分 |

## 待办

1. **实测定性**：起一个 CFoT 实例打开方舟，CDP 里读 `window.innerHeight` 与
   方舟顶部菜单元素的 `getBoundingClientRect()`，区分视口偏移与渲染异常。
2. **实测提示条可控性**：CFoT 常驻提示是否可手动关闭（截图中未见关闭按钮）、
   `--test-type` 等参数能否抑制，均未验证，不预设结论。
3. 根据实测结果在下列方向中选一个，再拆实现票。

## 候选修复方向（未排期，未改代码）

1. **换正式版 Chrome 驱动**：dev 已有回退路径（Rust 侧回退系统 Chrome），
   服务端 `VESTUS_MANAGED_CHROMIUM_PATH` 支持指定路径。正式版无此提示条；
   需回归验证登录/风控行为。
2. **保留 CFoT + 窗口几何补偿**：`WindowGeometry` 高度预留 infobar 预算，
   或启动后按实测视口差值校准。
3. **抑制提示条参数**（若实测有效）。

## Comments

### 2026-11-04 社区调研：这条提示条的通行处理方式

**1. Playwright 官方做法（最直接可抄）：`--disable-infobars`**
Playwright 源码 `chromiumSwitches.ts` 里明确带了这个参数，注释原话：

> This disables Chrome for Testing infobar that is visible in the persistent context.
> The switch is ignored everywhere else, including Chromium/Chrome/Edge.

即 `--disable-infobars` 对 **CFoT 构建 + 持久化 profile（--user-data-dir）** 的这条提示条依然有效，
对 Chromium/正式版 Chrome/Edge 则被忽略（它们本来也没这条）。我们的启动形态
（chrome.exe + user-data-dir）正是 persistent context，属于可直接照抄的一等方案。
注意区分：对**正式版 Chrome 的「Chrome 正受到自动测试软件的控制」提示条**，
`--disable-infobars` 早在 ~M65 就失效了（playwright#36238 亦证实被忽略）——两回事，别混。

**2. Puppeteer#10516（该问题的主要讨论帖）：官方立场 + 社区 workaround**
- 维护者表态：这条提示是 CFoT 的产品级硬性要求，**官方不支持移除**；不想要就换 Chromium 构建。
- 后续社区 workaround（多个 👍）：`--test-type=gpu` 可去掉；原帖作者实测裸 `--test-type` **不够**。
- `--test-type` 语义：良性的测试用途开关，主要抑制 UI 警告类 infobar 与首启建档行为，
  不改渲染/网络行为；非官方承诺，未来版本可能失效。

**3. 结构性方案：换构建/渠道**
- Chromium 构建（非 CFoT）：无此提示（官方建议）。
- 正式版 Chrome/Edge 渠道：无 CFoT 提示条；我们也没传 `--enable-automation`，
  仅 `--remote-debugging-port` 不会触发正式版的自动化提示条 → 很可能一条横条都没有。

**4. 不适用/已死的方案**
- `--disable-infobars` 去掉正式版自动化提示条：已死（~M65）。
- Selenium 的 `excludeSwitches: ['enable-automation']`：场景不符，我们本就没传该开关。
- headless：无 UI 即无提示条，但我们是给客户看的有头窗口，不适用。

**5. 顺带发现（Windows 相关，值得跟进）**
Playwright 还带 `--disable-stack-profiler`，注释：CFoT 启用的栈采样分析器在 Windows 上
展开主线程时会崩溃。客户机恰好是 Windows，这条对稳定性可能同样相关，待验证。

**映射到我们**：首选在 `chromium_arguments()` 加 `--disable-infobars`（照抄 Playwright 的
persistent context 处理，一行参数、风险最低，需实测 v153 仍有效）；备选 `--test-type=gpu`；
结构性方案为换正式版 Chrome 渠道。提示条去掉后视口少 ~40px 的问题随之消失，
「菜单顶部被挡」的主诉即解除。

来源：[Playwright chromiumSwitches.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts) ·
[puppeteer#10516](https://github.com/puppeteer/puppeteer/issues/10516) ·
[playwright#36238](https://github.com/microsoft/playwright/issues/36238) ·
[SQA: how to disable infobar](https://sqa.stackexchange.com/questions/32444/how-to-disable-infobar-from-chrome)

### 2026-11-05 设计稿已出，待评审

[docs/design/2026-11-05-托管浏览器提示条治理设计.md](../../../docs/design/2026-11-05-托管浏览器提示条治理设计.md)。
结论：采用① `--disable-infobars`（Playwright 现役做法，改动为 browser.rs 一行参数 +
一条测试断言）；`--test-type=gpu` 为备选；换正式版 Chrome/Edge 渠道列为长期项单独决策。
落地拆票建议见设计稿第 7 节。评审通过后按拆票实施。
