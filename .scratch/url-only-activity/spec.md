# 地址专用浏览器活动采集

状态：实现与本地两轮验证完成（客户 Windows 素材场景未验证）

来源：2026-11-16 本会话，用户明确取消 input/change，要求只上报标签页地址，并确认保留脱敏查询参数以维持 advid 索引。

基线：16753f4aa6377b94c0ea6225686c5b2624ae6fd1（HEAD，未提交工作区修改）。

## 要求

1. 新采集仅包含顶层标签页地址、已有脱敏查询参数、访问增量及投递必要元数据。
2. 不采 clicks/inputs/submits/scrolls/dwell 或表单快照；删除页面活动脚本、binding 和 Runtime.enable 事件订阅。
3. 覆盖已加载页面、整文档导航、SPA、弹窗与新标签页；不把 iframe 路由计为标签页访问；不重复播种初始导航。
4. 保留暂停/放行和 worker resume-before-detach 顺序、托管固定登录防护；输入事件防护不是采集，不能删除。
5. 没有后续 CDP 消息的登录页也须在现有4秒截止时间失效；取消/关闭标签页不能误触发；Expired/ConnectionLost区分保持。
6. 新上报省略交互字段；旧staged数据保留原内容转批，旧ready按原JSON/batchID重试，不改变owner/ACK/容量/FULL/历史数据语义。
7. 保留advid广告账户索引，无数据库迁移、无后端生产协议变更；历史管理页保留快照显示。
8. 强化静态边界及显式真实Chromium门禁，验证上述行为；隔离profile/localhost，不读真实登录或队列。
9. 不默认关闭GPU/视频解码，不改变代理/沙箱，不批量化队列持久性、不清理用户profile。
10. 不提交/push/打包/发布；客户Windows真实素材选择收益和GPU/内存根因仍未验证。

## 验证边界

- CDP生产collect报告流、命令集和托管信号，含真实随包Chromium。
- 新live→staged/ready内容与旧队列重开/原样重放。
- 后端v2 POST/ACK重试及新地址增量不清除历史、参数导出。
- 桌面/管理页面类型检查、构建、静态安全边界与本地回归，两轮同口径通过后交付。
