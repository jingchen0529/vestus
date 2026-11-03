use super::*;

fn state() -> WatchState {
    WatchState::new(LogoutPolicy::for_platform("https://agent.oceanengine.com/").unwrap())
}

fn attach(state: &mut WatchState, session: &str, target: &str) {
    state
        .observe(&json!({"method": "Target.attachedToTarget", "params": {
            "sessionId": session, "targetInfo": {"type": "page", "targetId": target}
        }}))
        .unwrap();
}

fn reply(state: &mut WatchState, command: &Value) {
    let result = match command["method"].as_str().unwrap() {
        "Page.addScriptToEvaluateOnNewDocument" => json!({"identifier": "guard"}),
        "Page.getFrameTree" => {
            json!({"frameTree": {"frame": {"id": "main", "url": "about:blank"}}})
        }
        _ => json!({}),
    };
    state
        .observe(&json!({"id": command["id"], "result": result}))
        .unwrap();
}

fn navigation(session: &str, url: &str) -> Value {
    json!({"method": "Page.frameNavigated", "sessionId": session,
        "params": {"frame": {"id": "main", "url": url}}})
}

#[test]
fn every_interleaved_attach_installs_before_resume() {
    let mut state = state();
    attach(&mut state, "first", "page-1");
    let first = state.outgoing.pop_front().unwrap();
    // The other attaches arrive while Page.enable awaits its reply.
    for number in 2..=6 {
        attach(
            &mut state,
            &format!("session-{number}"),
            &format!("page-{number}"),
        );
    }
    reply(&mut state, &first);
    let mut installed = HashSet::new();
    let mut resumed = HashSet::new();
    while let Some(command) = state.outgoing.pop_front() {
        let session = command["sessionId"].as_str().unwrap().to_string();
        match command["method"].as_str().unwrap() {
            "Page.addScriptToEvaluateOnNewDocument" => {
                assert_eq!(command["params"]["runImmediately"], true);
                assert!(!command["params"]["source"]
                    .as_str()
                    .unwrap()
                    .contains("__VESTUS_LOGIN_ROUTE__"));
                installed.insert(session.clone());
            }
            "Runtime.runIfWaitingForDebugger" => {
                assert!(installed.contains(&session));
                resumed.insert(session);
            }
            _ => {}
        }
        reply(&mut state, &command);
    }
    assert_eq!(installed.len(), 6);
    assert_eq!(resumed.len(), 6);
    assert!(state.pages.values().all(|page| page.ready));
    assert!(state.pending.is_empty());
}

#[test]
fn auto_attach_during_subscription_reply_is_not_lost() {
    let mut state = state();
    state.opening_commands();
    let discover = state.outgoing.pop_front().unwrap();
    let auto = state.outgoing.pop_front().unwrap();
    attach(&mut state, "early", "page");
    reply(&mut state, &discover);
    reply(&mut state, &auto);
    assert_eq!(state.outgoing.front().unwrap()["method"], "Page.enable");
    assert!(state.pages.contains_key("early"));
    assert!(state.auto_attach_ready);
}

#[test]
fn duplicate_session_cannot_resume_unprotected_primary() {
    let mut state = state();
    attach(&mut state, "primary", "page");
    attach(&mut state, "duplicate", "page");
    assert_eq!(state.outgoing.len(), 1);
    let mut primary_resumed = false;
    let mut installs = 0;
    while let Some(command) = state.outgoing.pop_front() {
        if command["method"] == "Page.addScriptToEvaluateOnNewDocument" {
            installs += 1;
        }
        if command["method"] == "Runtime.runIfWaitingForDebugger" {
            if command["sessionId"] == "duplicate" {
                assert!(primary_resumed);
            } else {
                primary_resumed = true;
            }
        }
        reply(&mut state, &command);
    }
    assert_eq!(installs, 1);
    assert_eq!(state.pages.len(), 1);
    assert!(state.duplicates.is_empty());
}

#[test]
fn new_unprotected_login_target_fails_closed_without_expiring_credentials() {
    for method in [
        "Target.targetCreated",
        "Target.targetInfoChanged",
        "Target.attachedToTarget",
    ] {
        let mut state = state();
        let result = state.observe(&json!({"method": method, "params": {
            "sessionId": "late", "targetInfo": {"type": "page", "targetId": "late-page",
                "url": "https://agent.oceanengine.com/login?redirect=/admin/homepage"}
        }}));
        assert!(result.is_err(), "unguarded first document: {method}");
        assert!(!state.detector.detected);
        assert!(state.detector.login_deadline().is_none());
    }
}

#[test]
fn prepared_tab_login_can_auto_redirect_within_settle_window() {
    let mut state = state();
    attach(&mut state, "ready", "page");
    while let Some(command) = state.outgoing.pop_front() {
        reply(&mut state, &command);
    }
    state.observe(&json!({"method": "Target.targetInfoChanged", "params": {
        "targetInfo": {"type": "page", "targetId": "page", "url": "https://agent.oceanengine.com/login"}
    }})).unwrap();
    assert!(state.detector.login_deadline().is_some());
    state
        .observe(&navigation(
            "ready",
            "https://agent.oceanengine.com/admin/homepage",
        ))
        .unwrap();
    assert!(state.detector.login_deadline().is_none());
}

#[test]
fn login_deadlines_are_independent_and_do_not_reset() {
    let mut state = state();
    attach(&mut state, "first", "page-1");
    attach(&mut state, "second", "page-2");
    let login = "https://agent.oceanengine.com/login";
    state.observe(&navigation("first", login)).unwrap();
    let first_deadline = state.detector.login_deadline().unwrap();
    state.observe(&navigation("second", login)).unwrap();
    state
        .observe(&navigation("first", &format!("{login}/password?next=home")))
        .unwrap();
    assert_eq!(state.detector.login_deadline(), Some(first_deadline));
    state
        .observe(&navigation(
            "second",
            "https://agent.oceanengine.com/admin/homepage",
        ))
        .unwrap();
    assert_eq!(state.detector.pending_login.len(), 1);
    assert!(state.detector.login_expired_at(first_deadline));
    state
        .observe(&json!({"method": "Target.detachedFromTarget", "params": {"sessionId": "second"}}))
        .unwrap();
    assert_eq!(state.detector.login_deadline(), Some(first_deadline));
    state
        .observe(&navigation(
            "first",
            "https://agent.oceanengine.com/admin/homepage",
        ))
        .unwrap();
    assert_eq!(state.detector.login_deadline(), None);
}

#[test]
fn stale_frame_tree_reply_does_not_cancel_new_login_navigation() {
    let mut state = state();
    attach(&mut state, "page", "target");
    let enable = state.outgoing.pop_front().unwrap();
    reply(&mut state, &enable);
    let install = state.outgoing.pop_front().unwrap();
    reply(&mut state, &install);
    let tree = state.outgoing.pop_front().unwrap();
    state
        .observe(&navigation("page", "https://agent.oceanengine.com/login"))
        .unwrap();
    reply(&mut state, &tree); // Snapshot says about:blank, but a newer navigation won.
    assert!(state.detector.login_deadline().is_some());
}

#[test]
fn destroyed_tab_cancels_pending_commands_without_expiring_other_tabs() {
    let mut state = state();
    attach(&mut state, "first", "target");
    state
        .observe(&navigation("first", "https://agent.oceanengine.com/login"))
        .unwrap();
    state
        .observe(&json!({"method": "Target.targetDestroyed", "params": {"targetId": "target"}}))
        .unwrap();
    assert!(state.pending.is_empty());
    assert!(state.pages.is_empty());
    assert!(state.detector.login_deadline().is_none());
    assert!(!state.detector.detected);
}

#[test]
fn command_failure_is_local_not_a_credential_expiry() {
    let mut state = state();
    attach(&mut state, "first", "target");
    let command = state.outgoing.pop_front().unwrap();
    let error = state
        .observe(&json!({"id": command["id"], "error": {"message": "secret URL or script"}}))
        .unwrap_err();
    assert_eq!(
        error,
        ManagedCdpError::Command("托管安全监控命令失败".into())
    );
    assert!(!state.detector.detected);
    assert!(state.detector.login_deadline().is_none());
}

#[test]
fn detached_live_page_is_a_local_guard_failure() {
    let mut state = state();
    attach(&mut state, "first", "target");
    state
        .observe(&json!({"method": "Target.detachedFromTarget", "params": {"sessionId": "first"}}))
        .unwrap();
    let targets = state
        .outgoing
        .iter()
        .find(|command| command["method"] == "Target.getTargets")
        .unwrap()
        .clone();
    let result = state.observe(&json!({"id": targets["id"], "result": {"targetInfos": [
        {"targetId": "target", "type": "page", "url": "https://agent.oceanengine.com/admin/homepage"}
    ]}}));
    assert!(result.is_err());
    assert!(!state.detector.detected);
}

#[test]
fn closing_a_tab_does_not_fail_the_guard() {
    let mut state = state();
    attach(&mut state, "first", "target");
    state
        .observe(&json!({"method": "Target.detachedFromTarget", "params": {"sessionId": "first"}}))
        .unwrap();
    let targets = state
        .outgoing
        .iter()
        .find(|command| command["method"] == "Target.getTargets")
        .unwrap()
        .clone();
    state
        .observe(&json!({"id": targets["id"], "result": {"targetInfos": []}}))
        .unwrap();
    assert!(state.detached_targets.is_empty());
    assert!(!state.detector.detected);
}

#[test]
fn heartbeat_timeout_is_local_even_while_other_events_arrive() {
    let mut state = state();
    state.request_targets();
    let deadline = state.pending.values().next().unwrap().deadline;
    assert_eq!(state.tick(deadline), Err(ManagedCdpError::Timeout));
    assert!(!state.detector.detected);
}

#[tokio::test]
async fn disconnected_watch_is_not_an_expired_credential() {
    use tokio::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = DevToolsEndpoint {
        port: listener.local_addr().unwrap().port(),
        browser_path: "/devtools/browser/disconnect-test".into(),
    };
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.close(None).await.unwrap();
    });
    let watch = LogoutWatch {
        socket: connect(&endpoint).await.unwrap(),
        state: state(),
    };
    assert!(!watch.wait().await.unwrap());
    server.await.unwrap();
}

#[test]
fn login_policy_is_exact_and_guard_contains_no_credentials() {
    let policy = LogoutPolicy::for_platform("https://agent.oceanengine.com/").unwrap();
    for url in [
        "https://agent.oceanengine.com/login",
        "https://agent.oceanengine.com/login/phone?redirect=/admin/homepage",
    ] {
        assert!(policy.matches_login(url));
    }
    for url in [
        "https://agent.oceanengine.com/login-help",
        "https://agent.oceanengine.com/?next=/login",
        "https://agent.oceanengine.com.evil.test/login",
        "http://agent.oceanengine.com/login",
        "https://agent.oceanengine.com:444/login",
        "https://user@agent.oceanengine.com/login",
        "https://localads.chengzijianzhan.cn/lamp/pc/home",
        "https://sso.oceanengine.com/login",
    ] {
        assert!(!policy.matches_login(url), "unexpected match: {url}");
    }
    let script = policy.login_guard_script();
    assert!(script.contains("https://agent.oceanengine.com"));
    for forbidden in [
        "document.cookie",
        "localStorage",
        "sessionStorage",
        "fetch(",
        "XMLHttpRequest",
        ".value",
        "FormData",
    ] {
        assert!(!script.contains(forbidden));
    }
}
