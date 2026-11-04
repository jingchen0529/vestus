//! Real Chromium regression suite for the managed single-connection model.
//!
//! v0.2.10 之后的独立防护连接已合并回采集连接（单 CDP 客户端 + 暂停/放行）。
//! 旧套件围绕"watch 连接"构建，已整体作废删除（见 git 历史）。重建后的回归
//! 必须覆盖：
//! - `window.open` 弹窗在托管模式下能正常导航（本次线上缺陷，v0.2.10 基准）；
//! - 登录页交互锁在首个真实文档生效（暂停期间注册脚本）；
//! - 登录页停留超窗与登出 URL 均产生 Expired 信号并走凭据过期上报；
//! - 采集连接断开产生 ConnectionLost 信号且不误报凭据过期；
//! - 普通手工登录 profile 行为不变。
//!
//! 重建前，检测逻辑由 managed_cdp.rs 内联单元测试与 cdp.rs 状态机测试覆盖。
