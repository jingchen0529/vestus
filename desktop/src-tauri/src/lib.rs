//! Vestus — 带认证的 HTTP 代理独立浏览器。
//!
//! 模块划分：
//! - [`httpio`]   最小 HTTP 报文头解析
//! - [`upstream`] 上游代理连接，默认路径唯一出站点
//! - [`bypass`]   管理员下发的直连域名列表，第二个也是最后一个出站点
//! - [`adapter`]  本地 HTTP 代理适配器，为 Chromium 补上游认证并做代理/直连路由
//! - [`probe`]    出口 IP 探测
//! - [`config`]   管理员下发代理配置的内存校验
//! - [`device`]   操作系统暴露的机器标识（登录与上报时携带）
//! - [`auth`]     桌面用户认证（令牌仅存 Rust 与系统钥匙串）
//! - [`profile`]  持久浏览器环境：按服务器、账号、平台、代理/直连隔离的 profile 目录
//! - [`browser`]  外置 Chromium 多会话：一个环境一个进程、复用与正常关闭
//! - [`cdp`]      浏览器活动采集（DevTools 协议，只取页面地址与操作次数）
//! - [`activity`] 采集结果的聚合与批量上报
//! - [`state`]    运行状态机
//! - [`commands`] 暴露给前端的 IPC

mod activity;
mod adapter;
mod auth;
mod browser;
mod bypass;
mod cdp;
mod commands;
mod config;
mod device;
mod httpio;
mod probe;
mod profile;
mod rt;
mod state;
mod upstream;

use activity::ActivityCollector;
use auth::DesktopAuthState;
use browser::BrowserSessionManager;
use state::AppState;
use tauri::Manager;

pub fn run() {
    // 预热运行时，后续命令直接复用
    let _ = rt::runtime();

    let app = tauri::Builder::default()
        .manage(AppState::default())
        .manage(DesktopAuthState::default())
        .manage(BrowserSessionManager::default())
        .manage(ActivityCollector::default())
        .setup(|app| {
            // 旧版本的临时 profile 只会在崩溃后残留（审计 F-13）。放到后台线程清：
            // 目录可能很大，不能拖慢启动。
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                let _ = std::thread::Builder::new()
                    .name("vestus-profile-sweep".into())
                    .spawn(move || {
                        profile::sweep_legacy_sessions(&cache_dir);
                    });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::desktop_login,
            auth::desktop_product_name,
            auth::desktop_product_info,
            auth::desktop_restore_session,
            auth::desktop_logout,
            auth::desktop_change_password,
            commands::sync_desktop_config,
            commands::open_browser,
            commands::reset_browser_profiles,
            commands::get_direct_ip,
            commands::get_status,
            commands::open_external_url,
            commands::check_github_release,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            // 顺序是硬要求：浏览器先被收走，调试通道才会断，采集才走到最后一次
            // 上报；反过来就是等一个永远不会结束的任务。浏览器是请它们正常退出的
            // （持久 profile 要落盘），所以这一步最多会等几秒。
            app_handle.state::<BrowserSessionManager>().shutdown();
            app_handle.state::<ActivityCollector>().shutdown();
            app_handle.state::<AppState>().shutdown();
        }
    });
}
