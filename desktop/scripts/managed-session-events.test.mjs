import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function statusHandler(app) {
  const start = app.indexOf(".onStatusChange");
  const end = app.indexOf(".then((unlisten) => {", start);
  return app.slice(start, end);
}

function guardFailedSubscription(app) {
  const start = app.indexOf(".onManagedSessionGuardFailed");
  const end = app.indexOf("\n    return () => {", start);
  assert.ok(start !== -1 && end > start);
  return app.slice(start, end);
}

test("late ignored managed reports must not resync and close newly opened browsers", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const handler = app.slice(
    app.indexOf(".onManagedSessionExpired"),
    app.indexOf("unlistenExpiredFn = unlisten"),
  );
  assert.match(handler, /payload\.reported && payload\.applied/);
  assert.match(handler, /未影响新凭据/);
  assert.match(handler, /!payload\.browserClosed/);
  assert.match(handler, /!payload\.reported/);
});

test("lease changes auto-resync the desktop config without manual refresh", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const handler = statusHandler(app);
  assert.match(handler, /desktop_config_changed/);
  // Failures retain the last config; only a successful, current sync may announce success.
  assert.match(handler, /syncDesktopConfig\(false, true\)\.then\(\(synced\) =>/);
  assert.match(handler, /if \(synced && isActive\(\)\)/);
  assert.match(handler, /配置已自动同步/);
  const tail = handler.slice(handler.indexOf("desktop_config_changed"));
  assert.doesNotMatch(tail, /setDesktopConfig\(null\)/);
});

test("guard failures expose an independent event and monitor-only payload", () => {
  const bridge = readFileSync(new URL("../src/services/tauriBridge.ts", import.meta.url), "utf8");
  const payload = bridge.match(/export interface ManagedSessionGuardFailedEvent \{([^}]+)\}/)?.[1];
  assert.ok(payload);
  assert.deepEqual(payload.trim().split("\n").map((line) => line.trim()), [
    "platformId: number;",
    "managedAccountId: number;",
    "credentialVersion: number;",
    "browserId: number;",
    'reason: "monitor_disconnected" | "monitor_failed";',
    "browserClosed: boolean;",
  ]);

  const listener = bridge.match(/async onManagedSessionGuardFailed\([\s\S]*?\n  \},/)?.[0];
  assert.ok(listener);
  assert.match(listener, /callback: \(payload: ManagedSessionGuardFailedEvent\) => void/);
  assert.match(listener, /Promise<\(\) => void>/);
  assert.match(listener, /if \(!isTauri\(\)\) \{\s*throw new Error\(/);
  assert.match(listener, /await import\("@tauri-apps\/api\/event"\)/);
  assert.match(listener, /return await listen<ManagedSessionGuardFailedEvent>\(\s*"managed-session-guard-failed"/);
  assert.match(listener, /callback\(event\.payload\)/);
  assert.doesNotMatch(listener, /managed-session-(?:expired|recovered)|ManagedSession(?:Expired|Recovered)|invokeDesktop/);
});

test("guard failures do not resync, reopen, recover, or change global proxy state", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const subscription = guardFailedSubscription(app);
  assert.doesNotMatch(subscription, /syncDesktopConfig|openBrowser|onManagedSession(?:Expired|Recovered)/);
  assert.doesNotMatch(subscription, /sessionStatus|autoRelogin|recoveryStatus|recovered|reported|applied/);
  assert.doesNotMatch(subscription, /setStatus|setDesktopConfig\w*|setProxyEnabled|handleProxyEnabledChange|localStorage|logout/);
  assert.doesNotMatch(statusHandler(app), /managed-session-guard-failed|monitor_disconnected|monitor_failed/);
});

test("guard failures show closure-specific error messages without invalidating credentials", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const subscription = guardFailedSubscription(app);
  const branches = subscription.match(/if \(payload\.browserClosed\) \{([\s\S]*?)\} else \{([\s\S]*?)\}/);
  assert.ok(branches);
  assert.match(branches[1], /"托管浏览器已关闭", cause \+ "，请重新打开平台；托管账号凭据未被标记为失效"/);
  assert.match(branches[2], /"托管浏览器关闭未确认", cause \+ "，请手动关闭对应浏览器后重试"/);
  assert.match(
    subscription,
    /payload\.reason === "monitor_disconnected" \? "安全监控连接断开" : "安全监控中断"/,
  );
  assert.doesNotMatch(subscription, /\b(?:info|success)\(/);
});

test("connection-loss faults close the browser and return before credential reporting", () => {
  const commands = readFileSync(new URL("../src-tauri/src/commands/managed.rs", import.meta.url), "utf8");
  const watch = commands.slice(commands.indexOf("async fn run_managed_watch"));
  // Only the reviewed ConnectionLost signal enters the local-fault closure path.
  assert.match(watch, /wait_managed_signal\(\s*&context\.status,\s*&mut signals,\s*&mut exited\s*\)\s*\.await/);
  const lostStart = watch.search(/if\s+matches!\(\s*detected,\s*crate::cdp::ManagedSignal::ConnectionLost\s*\)/);
  const eventAt = watch.indexOf('"managed-session-guard-failed"', lostStart);
  const reportAt = watch.indexOf(".report_managed_session_expired(");
  assert.ok(lostStart >= 0 && eventAt > lostStart, "断连故障必须发 guard-failed 事件");
  const lostBranch = watch.slice(lostStart, watch.indexOf("return;", eventAt) + "return;".length);
  assert.match(lostBranch, /kill_managed_browser_with_reason\(\s*context\.browsers\.clone\(\),\s*context\.browser_id,\s*CloseReason::MonitorDisconnected/);
  assert.match(lostBranch, /current_identity\(\)/);
  assert.match(lostBranch, /generation == context\.auth_generation/);
  assert.match(lostBranch, /"browserClosed": closed/);
  assert.match(lostBranch, /"reason": "monitor_disconnected"/);
  assert.ok(
    eventAt < reportAt,
    "本地故障分支必须整体位于凭据过期上报之前，且不得调用上报"
  );
  assert.doesNotMatch(lostBranch, /report_managed_session_expired|wait_managed_recovery|\.mark_error\(/);
});

test("stale expiry is rechecked after confirmation grace and ignored while monitoring is healthy", () => {
  const commands = readFileSync(new URL("../src-tauri/src/commands/managed.rs", import.meta.url), "utf8");
  const start = commands.indexOf("async fn wait_managed_signal");
  const end = commands.indexOf("async fn run_managed_watch", start);
  assert.ok(start >= 0 && end > start);
  const wait = commands.slice(start, end);
  assert.match(wait, /loop\s*\{/);
  assert.match(wait, /_\s*=\s*&mut\s*\*exited\s*=>\s*return None/);
  assert.match(wait, /!matches!\(signal,\s*Some\(crate::cdp::ManagedSignal::Expired\)\)/);
  const graceAt = wait.search(/sleep\(Duration::from_millis\(200\)\)/);
  const reviewAt = wait.indexOf("match status.current()");
  assert.ok(graceAt >= 0 && reviewAt > graceAt, "expiry status must be rechecked after grace");
  assert.match(wait, /LoginGuardStatus::ExpiryValid\s*=>\s*return signal/);
  assert.match(
    wait,
    /LoginGuardStatus::MonitorGone\s*=>\s*\{\s*return Some\(crate::cdp::ManagedSignal::ConnectionLost\)\s*\}/,
  );
  assert.match(wait, /LoginGuardStatus::NotExpired\s*=>\s*\{\s*\}/);
  assert.doesNotMatch(wait, /kill_|report_managed_session_expired|emit\(/);
});

test("expired signals run the full credential reporting flow", () => {
  const commands = readFileSync(new URL("../src-tauri/src/commands/managed.rs", import.meta.url), "utf8");
  const watch = commands.slice(commands.indexOf("async fn run_managed_watch"));
  const reviewAt = watch.indexOf("wait_managed_signal(");
  assert.ok(reviewAt >= 0);
  const flow = watch.slice(reviewAt);
  assert.match(flow, /spawn_blocking\(move \|\| \{\s*if !status\.is_expiry_valid\(\) \{\s*return None;\s*\}\s*Some\(browsers\.kill_browser_with_reason/);
  assert.match(flow, /Ok\(None\)\s*=>\s*continue/);
  assert.match(flow, /kill_browser_with_reason\(\s*browser_id,\s*CloseReason::ManagedLogout\s*\)/);
  assert.match(flow, /report_managed_session_expired/);
  assert.match(flow, /"managed-session-expired"/);
  assert.match(flow, /wait_managed_recovery/);
});

test("collector drives the managed watch with a single CDP client", () => {
  const browser = readFileSync(new URL("../src-tauri/src/commands/browser.rs", import.meta.url), "utf8");
  const cookiesAt = browser.indexOf("managed_cdp::install_session_cookies");
  const spawnAt = browser.indexOf("run_managed_watch(");
  const startAt = browser.indexOf("activity_collector.start(");
  const waitAt = browser.indexOf(".wait_ready(");
  const navigateAt = browser.indexOf("managed_cdp::navigate_session");
  assert.ok(cookiesAt >= 0 && spawnAt > cookiesAt, "Cookie 必须先安装，再启动监控消费端");
  assert.ok(startAt > spawnAt && waitAt > startAt, "采集与监控必须先启动，再等待防护回执");
  assert.ok(navigateAt > waitAt, "防护就绪回执必须先于首文档导航");
  assert.match(browser.slice(waitAt, navigateAt), /managed_session_timeout/);
  assert.match(browser, /let status = monitor\.status_view\(\);/);
  assert.match(browser, /watch_context\.status = status;/);
  assert.match(browser, /let target_id = managed_cdp::install_session_cookies/);
  assert.match(browser, /GuardInstalled::for_target\(target_id\.clone\(\)\)/);
  assert.match(browser, /guarded_target = Some\(target_id\);/);
  const navigation = browser.slice(waitAt, browser.indexOf("if let Some(tx) = ready_tx", waitAt));
  assert.match(navigation, /rt::runtime\(\)\.spawn\(async move \{/);
  assert.match(navigation, /navigate_session\(\s*&endpoint,\s*&session,\s*&target\s*\)\s*\.await\s*\.is_err\(\)/);
  assert.match(navigation, /status\.mark_monitor_gone\(\);\s*let _ = signals\.send\(cdp::ManagedSignal::ConnectionLost\);/);
  assert.doesNotMatch(navigation, /ManagedSignal::Expired|report_managed_session_expired|timeout\(/);
  assert.doesNotMatch(browser, /managed_cdp::inject_session|prepare_logout_watch/);

  const cdpSource = readFileSync(new URL("../src-tauri/src/cdp.rs", import.meta.url), "utf8");
  const collectAt = cdpSource.indexOf("pub async fn collect(");
  const guardWatch = cdpSource.indexOf("waitForDebuggerOnStart", collectAt);
  assert.ok(guardWatch > collectAt);
  // 单客户端：采集连接内的暂停+放行是唯一模型，不再有第二条防护连接。
  const managedCdp = readFileSync(new URL("../src-tauri/src/managed_cdp.rs", import.meta.url), "utf8");
  assert.doesNotMatch(managedCdp, /setAutoAttach/);
  assert.match(managedCdp, /ManagedSessionMonitor/);
});

test("guard failure listeners ignore inactive effects and clean up late subscriptions", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const subscription = guardFailedSubscription(app);
  assert.match(app, /let unlistenGuardFailedFn: \(\(\) => void\) \| undefined;/);
  assert.match(subscription, /\.onManagedSessionGuardFailed\(\(payload\) => \{\s*if \(!isActive\(\)\) return;/);
  assert.match(subscription, /\.then\(\(unlisten\) => \{\s*if \(isActive\(\)\) unlistenGuardFailedFn = unlisten;\s*else unlisten\(\);\s*\}\)/);
  assert.match(subscription, /\.catch\(\(\) => \{/);

  const cleanupStart = app.indexOf("\n    return () => {", app.indexOf(".onManagedSessionGuardFailed"));
  const cleanupEnd = app.indexOf("\n  }, [", cleanupStart);
  assert.ok(cleanupStart !== -1 && cleanupEnd > cleanupStart);
  const cleanup = app.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /active = false;/);
  assert.match(cleanup, /if \(unlistenGuardFailedFn\) unlistenGuardFailedFn\(\);/);
  assert.ok(cleanup.indexOf("active = false;") < cleanup.indexOf("unlistenGuardFailedFn();"));
});
