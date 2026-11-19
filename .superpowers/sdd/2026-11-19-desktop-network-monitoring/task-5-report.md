# Task 5 管理端网络诊断 API、类型和页面报告

## 交付
- 新增 `NetworkDiagnosticsQuery`、分页响应、摘要、项目和筛选类型，以及空筛选转换器。
- `api.listNetworkDiagnostics` 固定发送 `page`、`pageSize` 与 camelCase 筛选参数，并复用现有信封解包。
- 管理端接入“网络诊断”导航、标题和页面。页面提供用户、设备、路由、网络模式、状态、日期筛选，筛选回到第一页，分页、刷新、空状态和请求错误状态。
- 统计卡展示 p50、p95 和失败率。列表不展示业务敏感字段，错误码和代理/CDP 路由使用中文标签。
- 新增 web focused test，覆盖 API 参数、类型、统计卡、分页、空状态、错误码和路由标签。

## 验证
- `npm --prefix web test -- network-diagnostics.test.mjs` 通过。当前脚本会执行 web test glob，共 129 项通过。
- `npm --prefix web run build` 通过。

## 未执行
- 未执行线上服务、浏览器交互和真实管理员账号验收。
- 未修改后端、desktop Rust 或 desktop React。

## 已知限制
- 页面按现有管理端模式由 App 维护列表请求状态，未增加导出功能。

## Task 5 fix round 1
- 将原先仅源码正则断言的测试改为 Vite SSR 行为测试。
- API 测试实际 mock `fetch`，断言 userId、deviceId、route、networkMode、status、startAt、endAt 的 camelCase 查询参数、分页参数、信封解包和请求 credentials。
- 页面测试实际服务端渲染组件，断言 p50/p95/失败率、空值、空状态、错误状态、代理/CDP 路由和中文错误码。
- 筛选分页使用可执行的页码重置 helper 测试，验证筛选改变回到第一页。

验证命令与结果：
- `npm --prefix web test -- network-diagnostics.test.mjs`：130 项通过（项目 test glob 会运行全部测试）。
- `npm --prefix web run build`：通过。

## Task 5 fix round 2
- 增加真实 `fetch` 失败行为测试，筛选变更使用页码 1 发起请求，并断言失败后状态清空旧 items/total 后保留错误信息。
- 增加 VPN 代理探针和浏览器 CDP 失败标签的 SSR 断言。
- 增加 p50、p95、p50Ms、p95Ms、failureRate 全为空时三个统计指标均显示空值的 SSR 断言。

验证：`npm --prefix web test -- network-diagnostics.test.mjs`，133 项通过。
