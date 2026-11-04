//! 暴露给前端的 IPC 命令入口。
//!
//! 按业务域拆分在子模块里,本文件只做模块声明与重导出,保证 `lib.rs` 的
//! `commands::<name>` 路径不变——也就是 `tauriBridge.ts` 看到的 command 面不变:
//! - [`common`]  共享错误形态、鉴权守卫、错误翻译、出口探测地址;
//! - [`config`]  桌面配置同步:下发校验、租约看门狗、代理适配器启动;
//! - [`browser`] 浏览器生命周期:打开平台、重置持久 profile;
//! - [`managed`] 托管会话后台 watch 与恢复等待;
//! - [`system`]  状态、出口 IP、外链、版本检查。
//!
//! 安全约束（与文档第 9 节一致）：
//! - 口令只进入 [`crate::config::ProxyForm`] 与当前 Rust 会话内存，绝不回传 JavaScript 或落盘；
//! - 返回给前端的任何结构体都不含口令字段；
//! - 浏览器窗口的代理只能是 `http://127.0.0.1:<port>`，不接受其他取值。

mod browser;
mod common;
mod config;
mod managed;
mod system;

pub(crate) use browser::*;
pub(crate) use common::*;
pub(crate) use config::*;
pub(crate) use managed::*;
pub(crate) use system::*;

#[cfg(test)]
mod tests;
