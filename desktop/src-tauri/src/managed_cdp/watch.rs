//! One event pump owns both command replies and page initialization. No command
//! wait may consume another page's attach event without scheduling its guard.

use super::*;
use std::collections::VecDeque;
use tokio::time::{timeout_at, Instant};

#[derive(Clone, Copy)]
enum CommandKind {
    Discover,
    AutoAttach,
    Targets(u64),
    Attach,
    Enable,
    Install,
    FrameTree(u64),
    Resume,
    ResumeDuplicate,
    Detach,
}

struct PendingCommand {
    kind: CommandKind,
    session_id: Option<String>,
    target_id: Option<String>,
    deadline: Instant,
}

struct WatchedPage {
    target_id: String,
    revision: u64,
    installed: bool,
    ready: bool,
}

struct WatchState {
    detector: LogoutDetector,
    script: String,
    pages: HashMap<String, WatchedPage>,
    duplicates: HashMap<String, String>,
    attaching: HashSet<String>,
    detached_targets: HashSet<String>,
    pending: HashMap<i64, PendingCommand>,
    outgoing: VecDeque<Value>,
    auto_attach_ready: bool,
    targets_seen: bool,
    target_revision: u64,
    next_heartbeat: Instant,
}

impl WatchState {
    fn new(policy: LogoutPolicy) -> Self {
        let script = policy.login_guard_script();
        Self {
            detector: LogoutDetector::new(policy),
            script,
            pages: HashMap::new(),
            duplicates: HashMap::new(),
            attaching: HashSet::new(),
            detached_targets: HashSet::new(),
            pending: HashMap::new(),
            outgoing: VecDeque::new(),
            auto_attach_ready: false,
            targets_seen: false,
            target_revision: 0,
            next_heartbeat: Instant::now() + WATCH_HEARTBEAT,
        }
    }

    fn command(
        &mut self,
        kind: CommandKind,
        method: &str,
        params: Value,
        session_id: Option<&str>,
        target_id: Option<&str>,
    ) {
        let id = next_command_id();
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session_id) = session_id {
            message["sessionId"] = json!(session_id);
        }
        self.pending.insert(
            id,
            PendingCommand {
                kind,
                session_id: session_id.map(str::to_string),
                target_id: target_id.map(str::to_string),
                deadline: Instant::now() + COMMAND_TIMEOUT,
            },
        );
        self.outgoing.push_back(message);
    }

    fn page_command(&mut self, session_id: &str, kind: CommandKind, method: &str, params: Value) {
        let target = self
            .pages
            .get(session_id)
            .map(|page| page.target_id.clone());
        if let Some(target) = target {
            self.command(kind, method, params, Some(session_id), Some(&target));
        }
    }

    fn opening_commands(&mut self) {
        // Only pages are paused. Workers/OOPIFs must keep running normally; the
        // top document guard hides and makes its complete login subtree inert.
        self.command(
            CommandKind::Discover,
            "Target.setDiscoverTargets",
            json!({"discover": true, "filter": [{"type": "page"}, {"exclude": true}]}),
            None,
            None,
        );
        self.command(
            CommandKind::AutoAttach,
            "Target.setAutoAttach",
            json!({"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true,
                   "filter": [{"type": "page"}, {"exclude": true}]}),
            None,
            None,
        );
    }

    fn request_targets(&mut self) {
        self.next_heartbeat = Instant::now() + WATCH_HEARTBEAT;
        if self
            .pending
            .values()
            .any(|command| matches!(command.kind, CommandKind::Targets(_)))
        {
            return;
        }
        self.command(
            CommandKind::Targets(self.target_revision),
            "Target.getTargets",
            json!({}),
            None,
            None,
        );
    }

    fn session_for_target(&self, target_id: &str) -> Option<String> {
        self.pages
            .iter()
            .find_map(|(session, page)| (page.target_id == target_id).then(|| session.clone()))
    }

    fn attach_target(&mut self, info: &Value) {
        if info.get("type").and_then(Value::as_str) != Some("page") {
            return;
        }
        let Some(target) = info
            .get("targetId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return;
        };
        if self.session_for_target(target).is_some() || !self.attaching.insert(target.to_string()) {
            return;
        }
        self.command(
            CommandKind::Attach,
            "Target.attachToTarget",
            json!({"targetId": target, "flatten": true}),
            None,
            Some(target),
        );
    }

    fn attached(&mut self, session_id: &str, target_id: &str) {
        self.attaching.remove(target_id);
        if self.pages.contains_key(session_id) || self.duplicates.contains_key(session_id) {
            return;
        }
        if let Some(primary) = self.session_for_target(target_id) {
            self.duplicates
                .insert(session_id.to_string(), target_id.to_string());
            // Never resume a duplicate before the primary installs its guard:
            // Runtime.runIfWaitingForDebugger releases the whole target.
            if self.pages.get(&primary).is_some_and(|page| page.ready) {
                self.release_duplicate(session_id, target_id);
            }
            return;
        }
        self.pages.insert(
            session_id.to_string(),
            WatchedPage {
                target_id: target_id.to_string(),
                revision: 0,
                installed: false,
                ready: false,
            },
        );
        self.detector.observe_attach(&json!({
            "method": "Target.attachedToTarget",
            "params": {"sessionId": session_id, "targetInfo": {"type": "page"}},
        }));
        self.page_command(session_id, CommandKind::Enable, "Page.enable", json!({}));
    }

    fn release_duplicate(&mut self, session_id: &str, target_id: &str) {
        self.command(
            CommandKind::ResumeDuplicate,
            "Runtime.runIfWaitingForDebugger",
            json!({}),
            Some(session_id),
            Some(target_id),
        );
    }

    fn remove_session(&mut self, session_id: &str) {
        self.pages.remove(session_id);
        self.duplicates.remove(session_id);
        self.detector.observe(&json!({
            "method": "Target.detachedFromTarget", "params": {"sessionId": session_id},
        }));
        self.pending
            .retain(|_, command| command.session_id.as_deref() != Some(session_id));
    }

    fn remove_target(&mut self, target_id: &str) {
        let sessions: Vec<_> = self
            .pages
            .iter()
            .filter(|(_, page)| page.target_id == target_id)
            .map(|(session, _)| session.clone())
            .chain(
                self.duplicates
                    .iter()
                    .filter(|(_, target)| *target == target_id)
                    .map(|(session, _)| session.clone()),
            )
            .collect();
        for session in sessions {
            self.remove_session(&session);
        }
        self.attaching.remove(target_id);
        self.detached_targets.remove(target_id);
        self.pending
            .retain(|_, command| command.target_id.as_deref() != Some(target_id));
    }

    fn check_target_login(&self, info: &Value) -> Result<(), ManagedCdpError> {
        if info.get("type").and_then(Value::as_str) != Some("page")
            || !info
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| self.detector.policy.matches_login(url))
        {
            return Ok(());
        }
        let guarded = info
            .get("targetId")
            .and_then(Value::as_str)
            .and_then(|target| self.session_for_target(target))
            .is_some_and(|session| self.pages.get(&session).is_some_and(|page| page.installed));
        if !guarded {
            // Chrome can start a URL-bearing new tab before its DevTools target
            // exists. Do not grant an unprotected first document a settle window.
            return Err(ManagedCdpError::Command(
                "新登录页面尚未建立托管防护".into(),
            ));
        }
        Ok(())
    }

    fn observe(&mut self, message: &Value) -> Result<(), ManagedCdpError> {
        if let Some(id) = message.get("id").and_then(Value::as_i64) {
            return self.reply(id, message);
        }
        match message.get("method").and_then(Value::as_str) {
            Some("Target.attachedToTarget") => {
                let info = &message["params"]["targetInfo"];
                let session = message
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .ok_or(ManagedCdpError::InvalidResponse)?;
                let target = info
                    .get("targetId")
                    .and_then(Value::as_str)
                    .ok_or(ManagedCdpError::InvalidResponse)?;
                if info.get("type").and_then(Value::as_str) == Some("page") {
                    self.check_target_login(info)?;
                    if self.detached_targets.contains(target) {
                        return Err(ManagedCdpError::Command("托管页面的防护连接已丢失".into()));
                    }
                    self.attached(session, target);
                } else {
                    self.release_duplicate(session, target);
                }
            }
            Some("Target.detachedFromTarget") => {
                if let Some(session) = message.pointer("/params/sessionId").and_then(Value::as_str)
                {
                    let target = self.pages.get(session).map(|page| page.target_id.clone());
                    self.remove_session(session);
                    if let Some(target) = target {
                        // A closing tab disappears from discovery. A live page
                        // that lost its guard must not be silently reattached.
                        self.detached_targets.insert(target);
                        self.target_revision += 1;
                        self.request_targets();
                    }
                }
            }
            Some("Target.targetDestroyed") => {
                if let Some(target) = message.pointer("/params/targetId").and_then(Value::as_str) {
                    self.remove_target(target);
                    self.target_revision += 1;
                }
            }
            Some("Target.targetCreated") => {
                self.check_target_login(&message["params"]["targetInfo"])?;
                if self.auto_attach_ready {
                    self.request_targets();
                }
            }
            Some("Target.targetInfoChanged") => {
                let info = &message["params"]["targetInfo"];
                self.check_target_login(info)?;
                if let Some(session) = info
                    .get("targetId")
                    .and_then(Value::as_str)
                    .and_then(|target| self.session_for_target(target))
                {
                    self.detector
                        .observe_url(&session, info.get("url").and_then(Value::as_str));
                }
            }
            Some("Page.frameNavigated" | "Page.navigatedWithinDocument") => {
                if let Some(page) = message
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .and_then(|session| self.pages.get_mut(session))
                {
                    page.revision += 1;
                }
                self.detector.observe(message);
            }
            _ => {}
        }
        Ok(())
    }

    fn reply(&mut self, id: i64, message: &Value) -> Result<(), ManagedCdpError> {
        let Some(command) = self.pending.remove(&id) else {
            return Ok(());
        };
        if let Some(error) = message.get("error") {
            let detail = error.get("message").and_then(Value::as_str).unwrap_or("");
            let closed = [
                "No session with given id",
                "Session with given id not found",
                "Session closed",
                "Target closed",
                "No target with given id",
                "No target found",
            ]
            .iter()
            .any(|prefix| detail.starts_with(prefix));
            if closed && (command.session_id.is_some() || command.target_id.is_some()) {
                if matches!(
                    command.kind,
                    CommandKind::ResumeDuplicate | CommandKind::Detach
                ) {
                    return Ok(());
                }
                if let Some(target) = command.target_id.as_deref() {
                    self.remove_target(target);
                    if !matches!(command.kind, CommandKind::Attach) {
                        self.detached_targets.insert(target.to_string());
                    }
                    self.target_revision += 1;
                }
                self.request_targets();
                return Ok(());
            }
            // Browser errors may contain URLs or script contents; never copy
            // those into logs, IPC, or a credential-expiry report.
            return Err(ManagedCdpError::Command("托管安全监控命令失败".into()));
        }
        let result = message
            .get("result")
            .ok_or(ManagedCdpError::InvalidResponse)?;
        let session = command.session_id.as_deref().unwrap_or("");
        match command.kind {
            CommandKind::Discover => {}
            CommandKind::AutoAttach => {
                self.auto_attach_ready = true;
                self.request_targets();
            }
            CommandKind::Targets(revision) => {
                let infos = result
                    .get("targetInfos")
                    .and_then(Value::as_array)
                    .ok_or(ManagedCdpError::InvalidResponse)?;
                if revision != self.target_revision {
                    self.request_targets();
                    return Ok(());
                }
                let live: HashSet<_> = infos
                    .iter()
                    .filter(|info| info.get("type").and_then(Value::as_str) == Some("page"))
                    .filter_map(|info| info.get("targetId").and_then(Value::as_str))
                    .collect();
                if self
                    .detached_targets
                    .iter()
                    .any(|target| live.contains(target.as_str()))
                {
                    return Err(ManagedCdpError::Command("托管页面的防护连接已丢失".into()));
                }
                self.detached_targets.clear();
                self.targets_seen = true;
                for info in infos {
                    self.check_target_login(info)?;
                    self.attach_target(info);
                }
            }
            CommandKind::Attach => {
                let target = command
                    .target_id
                    .as_deref()
                    .ok_or(ManagedCdpError::InvalidResponse)?;
                let attached = result
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or(ManagedCdpError::InvalidResponse)?;
                self.attached(attached, target);
            }
            CommandKind::Enable => {
                self.page_command(
                    session,
                    CommandKind::Install,
                    "Page.addScriptToEvaluateOnNewDocument",
                    json!({"source": self.script, "runImmediately": true}),
                );
            }
            CommandKind::Install => {
                if result
                    .get("identifier")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .is_none()
                {
                    return Err(ManagedCdpError::InvalidResponse);
                }
                if let Some(page) = self.pages.get_mut(session) {
                    page.installed = true;
                    let revision = page.revision;
                    self.page_command(
                        session,
                        CommandKind::FrameTree(revision),
                        "Page.getFrameTree",
                        json!({}),
                    );
                }
            }
            CommandKind::FrameTree(revision) => {
                let frame = result
                    .pointer("/frameTree/frame")
                    .ok_or(ManagedCdpError::InvalidResponse)?;
                if self
                    .pages
                    .get(session)
                    .is_some_and(|page| page.revision == revision)
                {
                    self.detector.observe_main_frame(session, frame);
                }
                self.page_command(
                    session,
                    CommandKind::Resume,
                    "Runtime.runIfWaitingForDebugger",
                    json!({}),
                );
            }
            CommandKind::Resume => {
                if let Some(page) = self.pages.get_mut(session) {
                    page.ready = true;
                    let target = page.target_id.clone();
                    let duplicates: Vec<_> = self
                        .duplicates
                        .iter()
                        .filter(|(_, id)| **id == target)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for duplicate in duplicates {
                        self.release_duplicate(&duplicate, &target);
                    }
                }
            }
            CommandKind::ResumeDuplicate => {
                self.command(
                    CommandKind::Detach,
                    "Target.detachFromTarget",
                    json!({"sessionId": session}),
                    None,
                    command.target_id.as_deref(),
                );
                self.duplicates.remove(session);
            }
            CommandKind::Detach => {}
        }
        Ok(())
    }

    fn ready(&self) -> bool {
        self.auto_attach_ready
            && self.targets_seen
            && self.detector.has_tracked_session()
            && self.pages.values().all(|page| page.ready)
            && self.pending.is_empty()
    }

    fn deadline(&self) -> Instant {
        self.pending
            .values()
            .map(|command| command.deadline)
            .fold(self.next_heartbeat, Instant::min)
    }

    fn tick(&mut self, now: Instant) -> Result<(), ManagedCdpError> {
        if self.pending.values().any(|command| now >= command.deadline) {
            return Err(ManagedCdpError::Timeout);
        }
        if now >= self.next_heartbeat {
            self.request_targets();
        }
        Ok(())
    }
}

/// The guard lives on its own CDP connection. `true` is a platform expiry signal;
/// `false` is a disconnected monitor, never evidence that a credential expired.
pub(crate) struct LogoutWatch {
    socket: ManagedSocket,
    state: WatchState,
}

impl LogoutWatch {
    async fn flush_commands(&mut self) -> Result<(), ManagedCdpError> {
        while let Some(command) = self.state.outgoing.pop_front() {
            let id = command["id"]
                .as_i64()
                .ok_or(ManagedCdpError::InvalidResponse)?;
            let Some(pending) = self.state.pending.get(&id) else {
                continue; // The tab closed before its queued command was sent.
            };
            timeout_at(
                pending.deadline,
                self.socket.send(Message::Text(command.to_string().into())),
            )
            .await
            .map_err(|_| ManagedCdpError::Timeout)?
            .map_err(|_| ManagedCdpError::Transport("安全监控连接已断开".into()))?;
        }
        Ok(())
    }

    async fn step(&mut self, deadline: Instant) -> Result<bool, ManagedCdpError> {
        self.flush_commands().await?;
        let next = match timeout_at(deadline, self.socket.next()).await {
            Ok(next) => next,
            Err(_) => return Ok(true),
        };
        match next {
            None | Some(Ok(Message::Close(_))) => Ok(false),
            Some(Ok(Message::Text(text))) => {
                let message =
                    serde_json::from_str(&text).map_err(|_| ManagedCdpError::InvalidResponse)?;
                self.state.observe(&message)?;
                Ok(true)
            }
            Some(Ok(_)) => Ok(true),
            Some(Err(_)) => Err(ManagedCdpError::Transport("安全监控连接已断开".into())),
        }
    }

    pub(crate) async fn wait(mut self) -> Result<bool, ManagedCdpError> {
        loop {
            let now = Instant::now();
            if self.state.detector.detected || self.state.detector.login_expired_at(now) {
                return Ok(true);
            }
            self.state.tick(now)?;
            let deadline = self
                .state
                .detector
                .login_deadline()
                .map_or(self.state.deadline(), |login| {
                    login.min(self.state.deadline())
                });
            if !self.step(deadline).await? {
                return Ok(false);
            }
        }
    }
}

pub(crate) async fn prepare_logout_watch(
    endpoint: &DevToolsEndpoint,
    session: &ManagedSession,
) -> Result<Option<LogoutWatch>, ManagedCdpError> {
    let Some(policy) = LogoutPolicy::for_platform(&session.target_url) else {
        return Ok(None);
    };
    prepare_logout_watch_with_policy(endpoint, policy)
        .await
        .map(Some)
}

pub(super) async fn prepare_logout_watch_with_policy(
    endpoint: &DevToolsEndpoint,
    policy: LogoutPolicy,
) -> Result<LogoutWatch, ManagedCdpError> {
    let mut watch = LogoutWatch {
        socket: connect(endpoint).await?,
        state: WatchState::new(policy),
    };
    watch.state.opening_commands();
    let deadline = Instant::now() + COMMAND_TIMEOUT * 3;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(ManagedCdpError::Timeout);
        }
        watch.state.tick(now)?;
        if watch.state.ready() {
            return Ok(watch);
        }
        if !watch.step(deadline.min(watch.state.deadline())).await? {
            return Err(ManagedCdpError::Transport(
                "安全监控初始化时连接已断开".into(),
            ));
        }
    }
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
