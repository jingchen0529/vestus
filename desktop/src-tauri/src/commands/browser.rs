//! 浏览器生命周期命令:打开平台、重置持久 profile。

use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};
use url::Url;

use crate::activity::{ActivityCollector, ActivityOwner, SessionKey as ActivitySessionKey};
use crate::auth::DesktopAuthState;
use crate::browser::{BrowserError, BrowserSessionManager};
use crate::cdp;
use crate::device;
use crate::managed_cdp;
use crate::profile::{self, ProfileSpec};
use crate::rt;
use crate::state::AppState;

use super::*;

/// 打开浏览器后返回的令牌，仅用于把状态机里的会话和 Chromium 进程对上。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserHandleView {
    pub browser_id: u64,
    /// 这个平台的浏览器本来就开着，这次没有启动新的浏览器进程。
    pub reused: bool,
    /// `reused` 为真时说明这次是把已有的同域标签切到了最前；重复点击不会创建
    /// 新标签或新窗口。
    pub tab_action: Option<String>,
    /// 实际使用的网络模式。托管平台可能把用户选择的直连请求强制改为代理。
    pub direct_mode: bool,
    /// 是否由后台托管会话启动；仅作为界面提示，不包含凭据。
    pub managed: bool,
}

/// 重置本机浏览器环境的结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserProfileResetView {
    /// 删掉的平台环境个数（代理与直连分开计）。
    pub removed: usize,
}

pub(crate) fn validate_bootstrap_account_id(
    requested: Option<i64>,
    returned: u64,
) -> CmdResult<i64> {
    let returned = i64::try_from(returned)
        .map_err(|_| CommandError::new("托管账号 ID 无效", "managed_session_invalid"))?;
    if let Some(requested) = requested {
        if requested != returned {
            return Err(CommandError::new(
                "托管登录会话与所选账号不一致",
                "managed_session_invalid",
            ));
        }
    }
    Ok(returned)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn open_browser<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
    browsers: tauri::State<'_, BrowserSessionManager>,
    activity: tauri::State<'_, ActivityCollector>,
    platform_id: i64,
    managed_account_id: Option<i64>,
    direct_mode: Option<bool>,
    disable_sandbox: Option<bool>,
) -> CmdResult<BrowserHandleView> {
    let mut direct_mode = direct_mode.unwrap_or(false);
    // 本机偏好：沙箱拉不起来的机器由用户在「系统配置」里关闭。默认保留沙箱。
    // 只影响 --no-sandbox，与代理链路正交。
    let disable_sandbox = disable_sandbox.unwrap_or(false);
    let _lifecycle_guard = state.lock_desktop_sync().await;
    require_desktop_auth(&auth)?;
    let (user_id, profile_key, auth_generation) =
        auth.current_identity().map_err(auth_command_error)?;
    let mut launch = state
        .resolve_browser_launch(
            user_id,
            auth_generation,
            profile_key.as_deref(),
            platform_id,
            managed_account_id,
            direct_mode,
        )
        .ok_or_else(|| {
            CommandError::new(
                "该平台不在管理员下发的允许列表中，请重新同步配置",
                "platform_not_allowed",
            )
        })?;
    // 先解析起始网址：下面分配浏览器槽位之后再失败，那个槽位就回收不了了。
    let target = Url::parse(&launch.target_url)
        .map_err(|error| CommandError::new(format!("起始网址无法解析：{error}"), "invalid_form"))?;
    // resolve_browser_launch 刚确认过它与这次同步下发的一致，走到这里不可能为空。
    let profile_key = profile_key
        .ok_or_else(|| CommandError::new("请先同步桌面配置，再打开浏览器", "not_ready"))?;
    let api_base = auth.api_base_url().map_err(auth_command_error)?.to_string();

    // A managed platform gets a profile namespace that includes the server
    // controlled account and credential version.  This prevents a rotated
    // account from inheriting the previous account's cookies/local storage.
    // The bootstrap payload is consumed only after the normal desktop auth
    // and platform allowlist checks above have succeeded.
    let requested_managed_account_id = managed_account_id;
    let device_id = device::wire_device_id();
    let managed_session = auth
        .fetch_managed_session::<managed_cdp::ManagedBootstrapWire>(
            platform_id,
            managed_account_id,
            device_id.clone(),
        )
        .await
        .map_err(auth_command_error)?
        .map(|wire| {
            let profile_key = format!(
                "{profile_key}::managed-account-{}::credential-version-{}",
                wire.managed_account_id, wire.credential_version
            );
            let managed_account_id = validate_bootstrap_account_id(
                requested_managed_account_id,
                wire.managed_account_id,
            )?;
            let session = managed_cdp::managed_session_from_bootstrap(target.as_str().into(), wire)
                .map_err(|error| {
                    CommandError::new(
                        format!("托管登录会话无效：{error}"),
                        "managed_session_invalid",
                    )
                })?;
            Ok::<_, CommandError>((profile_key, managed_account_id, session))
        })
        .transpose()?;
    let (browser_profile_key, resolved_managed_account_id, managed_session) = managed_session
        .map_or_else(
            || (profile_key.clone(), None, None),
            |(key, managed_account_id, session)| (key, Some(managed_account_id), Some(session)),
        );
    if requested_managed_account_id.is_some() && resolved_managed_account_id.is_none() {
        return Err(CommandError::new(
            "指定的托管账号不可用，请重新同步配置",
            "managed_account_not_found",
        ));
    }
    let managed_account_id = resolved_managed_account_id;

    // Managed sessions use the administrator-selected proxy route. A client
    // cannot create a second direct-mode profile containing the same account.
    if managed_session.is_some() && direct_mode {
        direct_mode = false;
        launch = state
            .resolve_browser_launch(
                user_id,
                auth_generation,
                Some(&profile_key),
                platform_id,
                managed_account_id,
                false,
            )
            .ok_or_else(|| {
                CommandError::new(
                    "托管平台必须使用管理员配置的代理线路",
                    "managed_proxy_required",
                )
            })?;
    }

    let profile = browsers
        .prepare_profile(
            &app,
            &ProfileSpec {
                api_base: &api_base,
                profile_key: &browser_profile_key,
                platform_id,
                direct_mode,
            },
        )
        .map_err(browser_command_error)?;

    // A credential rotation gets a new profile environment. Retire an older
    // managed version for this exact account/platform/mode before deciding
    // whether to reuse the current environment. Ordinary manual profiles in
    // the same account directory are deliberately left running.
    if let Some(managed_account_id) = managed_account_id {
        let account_dir = profile
            .dir()
            .parent()
            .expect("持久浏览器环境必须位于账号目录下")
            .to_path_buf();
        let _ = browsers
            .close_managed_profile_versions(
                &account_dir,
                platform_id,
                direct_mode,
                u64::try_from(managed_account_id).map_err(|_| {
                    CommandError::new("托管账号 ID 无效", "managed_session_invalid")
                })?,
                profile.dir(),
            )
            .await;
    }

    let local_proxy = launch.port.map(|p| format!("http://127.0.0.1:{p}"));

    if let Some(browser_id) = browsers.running_browser(profile.dir()) {
        // 已有浏览器只能激活已存在的平台标签。端点不可用、标签不存在或激活失败时
        // 直接失败；不创建第二个标签，也不转交到另一个窗口。
        // 托管复用也不再次注入：watcher 始终对应该进程最初使用的 bootstrap 身份。
        let endpoint = browsers.session_endpoint(browser_id).ok_or_else(|| {
            CommandError::new("平台页面尚未就绪，请稍后重试", "browser_page_unavailable")
        })?;
        cdp::open_or_activate_page(&endpoint, target.as_str())
            .await
            .map_err(|error| {
                let message = match error {
                    cdp::CdpError::NoMatchingPage => "平台页面已关闭，请重新初始化浏览器",
                    _ => "平台页面不可用，请关闭并重新打开浏览器",
                };
                CommandError::new(message, "browser_page_unavailable")
            })?;
        return Ok(BrowserHandleView {
            browser_id,
            reused: true,
            tab_action: Some("activated".into()),
            direct_mode,
            managed: managed_session.is_some(),
        });
    }

    // This is the identity on the exact ManagedSession injected below. Reused
    // browsers returned above and keep their original collector/grant identity.
    let bootstrap_session_id = managed_session
        .as_ref()
        .map(|session| {
            session
                .identity
                .as_ref()
                .and_then(|identity| identity.session_id.parse::<i64>().ok())
                .filter(|id| *id > 0)
                .ok_or_else(|| CommandError::new("托管会话票据 ID 无效", "managed_session_invalid"))
        })
        .transpose()?;
    let browser_id = state.mark_browser_opened(direct_mode).ok_or_else(|| {
        CommandError::new("请先同步并测试代理，通过后才能打开浏览器", "not_ready")
    })?;

    let state_for_exit = state.inner().clone();
    let app_for_exit = app.clone();
    // 采集通道：调试端点可读时才开，开不起来也只是这次会话没有日志。
    let activity_collector = activity.inner().clone();
    // Activity uploads are authorized against the server-issued base profile
    // key.  The managed account/version suffix is only the local Chromium
    // namespace and must never be sent as the owner's profile identity.
    let activity_owner = ActivityOwner::new(&api_base, &profile_key, user_id);
    let activity_key = ActivitySessionKey {
        browser_id,
        platform_id,
        managed_account_id,
        bootstrap_session_id,
        direct_mode,
    };
    let initial_url = if managed_session.is_some() {
        "about:blank"
    } else {
        target.as_str()
    };
    let managed_session_for_ready = managed_session.clone();
    let managed_launch = managed_session.is_some();
    let logout_context = managed_session
        .as_ref()
        .map(|session| ManagedLogoutContext {
            browsers: browsers.inner().clone(),
            auth: auth.inner().clone(),
            app: app.clone(),
            browser_id,
            platform_id,
            user_id,
            auth_generation,
            device_id,
            identity: session
                .identity
                .clone()
                .expect("consumed bootstrap has an identity"),
        });
    let (watch_exit_tx, watch_exit_rx) = if managed_launch {
        let (tx, rx) = tokio::sync::oneshot::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let (ready_tx, mut ready_rx) = if managed_launch {
        let (tx, rx) = tokio::sync::oneshot::channel::<CmdResult<()>>();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    if let Err(error) = browsers.launch(
        &app,
        browser_id,
        profile,
        local_proxy.as_deref(),
        initial_url,
        disable_sandbox,
        move |endpoint| {
            let mut managed_watch = None;
            let injection = if let Some(session) = managed_session_for_ready {
                rt::runtime().block_on(async {
                    // 托管会话的登出/登录页检测与登录页交互锁都由采集连接驱动
                    // （单 CDP 客户端，v0.2.10 验证过的模型）；第二条防护连接
                    // 会让 window.open 弹窗停在 about:blank，已废弃。
                    if let Some(context) = logout_context {
                        let (signal_tx, signal_rx) = tokio::sync::mpsc::unbounded_channel();
                        let unavailable = || {
                            CommandError::new(
                                "托管安全监控无法启用，请重新打开平台",
                                "managed_guard_unavailable",
                            )
                        };
                        let watch = cdp::ManagedWatch {
                            login_guard_script: managed_cdp::logout_guard_script(
                                &session.target_url,
                            )
                            .ok_or_else(unavailable)?,
                            monitor: managed_cdp::ManagedSessionMonitor::for_session(
                                &session.target_url,
                            )
                            .ok_or_else(unavailable)?,
                            signals: signal_tx,
                        };
                        let exited = watch_exit_rx.ok_or_else(unavailable)?;
                        rt::runtime().spawn(run_managed_watch(context, signal_rx, exited));
                        managed_watch = Some(watch);
                    }
                    managed_cdp::inject_session(&endpoint, &session)
                        .await
                        .map_err(|_| {
                            CommandError::new(
                                "托管登录会话注入失败，请重新打开平台或联系管理员",
                                "managed_session_invalid",
                            )
                        })
                })
            } else {
                Ok(())
            };
            if let Some(tx) = ready_tx {
                let _ = tx.send(injection.clone());
            }
            if injection.is_err() {
                return;
            }
            activity_collector.start(activity_key, endpoint, activity_owner, managed_watch);
        },
        move || {
            if let Some(tx) = watch_exit_tx {
                let _ = tx.send(());
            }
            // The browser manager owns cleanup and the lease; a late exit
            // callback must never reacquire the path and delete a new profile.
            state_for_exit.mark_browser_closed_for(browser_id);
            let _ = app_for_exit.emit("status-changed", state_for_exit.snapshot());
        },
    ) {
        state.mark_browser_closed_for(browser_id);
        emit_status(&app, &state);
        return Err(browser_command_error(error));
    }

    if let Some(rx) = ready_rx.take() {
        let ready = tokio::time::timeout(Duration::from_secs(35), rx).await;
        match ready {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => {
                kill_managed_browser(browsers.inner().clone(), browser_id).await?;
                state.mark_browser_closed_for(browser_id);
                emit_status(&app, &state);
                return Err(error);
            }
            Ok(Err(_)) | Err(_) => {
                kill_managed_browser(browsers.inner().clone(), browser_id).await?;
                state.mark_browser_closed_for(browser_id);
                emit_status(&app, &state);
                return Err(CommandError::new(
                    "托管浏览器初始化超时，请联系管理员重新验证账号",
                    "managed_session_timeout",
                ));
            }
        }
    }

    emit_status(&app, &state);
    Ok(BrowserHandleView {
        browser_id,
        reused: false,
        tab_action: None,
        direct_mode,
        managed: managed_session.is_some(),
    })
}

/// 删掉当前账号在本机的全部浏览器环境（各平台，代理与直连）。
///
/// 用于环境坏了、或者需要让平台把这台电脑当成一台新设备的时候。已打开的浏览器先按
/// 正常流程关掉：Windows 上删不掉正在用的文件，macOS 上则会把跑着的浏览器弄坏。别的
/// Vestus 实例还开着其中某个环境时一个都不删。其他账号、其他服务器的环境不受影响。
#[tauri::command]
pub async fn reset_browser_profiles<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
    browsers: tauri::State<'_, BrowserSessionManager>,
) -> CmdResult<BrowserProfileResetView> {
    let _lifecycle_guard = state.lock_desktop_sync().await;
    require_desktop_auth(&auth)?;
    let (_, profile_key, _) = auth.current_identity().map_err(auth_command_error)?;
    let profile_key = profile_key
        .ok_or_else(|| CommandError::new("请先同步桌面配置，再重置浏览器环境", "not_ready"))?;
    let api_base = auth.api_base_url().map_err(auth_command_error)?.to_string();
    let account_dir = browsers
        .account_profiles_dir(&app, &api_base, &profile_key)
        .map_err(browser_command_error)?;

    // 本实例里开着的浏览器都属于当前账号：换账号必先关掉全部浏览器。
    browsers.close_all().await;
    let removed = rt::runtime()
        .spawn_blocking(move || profile::remove_account(&account_dir))
        .await
        .map_err(|error| CommandError::new(format!("内部任务失败：{error}"), "internal"))?
        .map_err(|error| match error {
            profile::ResetError::Busy => browser_command_error(BrowserError::ProfileBusy),
            profile::ResetError::CheckFailed => {
                browser_command_error(BrowserError::ProfileCheckFailed)
            }
            profile::ResetError::Io(detail) => {
                CommandError::new(format!("浏览器环境没能全部删除：{detail}"), "reset_failed")
            }
        })?;
    Ok(BrowserProfileResetView { removed })
}
