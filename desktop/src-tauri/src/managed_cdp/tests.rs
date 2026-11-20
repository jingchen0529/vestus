//! Local-only managed watch uses the production fixed guard and monitor. No
//! bootstrap credentials or real platform/network/profile are used by acceptance.
use super::*;

pub(super) fn localhost_watch(
    base_url: &str,
    signals: tokio::sync::mpsc::UnboundedSender<crate::cdp::ManagedSignal>,
) -> crate::cdp::ManagedWatch {
    let base = Url::parse(base_url).unwrap();
    assert_eq!(base.scheme(), "http");
    assert_eq!(base.host_str(), Some("127.0.0.1"));
    let policy = LogoutPolicy {
        endpoint: base.join("logout").unwrap(),
        login_route: base.join("login").unwrap(),
    };
    let monitor = ManagedSessionMonitor {
        detector: LogoutDetector::new(policy.clone()),
        notified: false,
        status: LoginGuardStatusView::default(),
    };
    let status = monitor.status_view();
    crate::cdp::ManagedWatch {
        login_guard_script: policy.login_guard_script(),
        monitor,
        signals,
        status,
        guard_installed: GuardInstalled::default(),
    }
}
