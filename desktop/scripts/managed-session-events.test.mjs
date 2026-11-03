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
  // 自动重同步在前；只有重同步失败才降级为需要人工处理的旧提示。
  assert.match(handler, /await syncDesktopConfig\(false\)/);
  assert.match(handler, /配置已自动同步/);
  const tail = handler.slice(handler.indexOf("desktop_config_changed"));
  const syncAt = tail.indexOf("await syncDesktopConfig(false)");
  const fallbackAt = tail.indexOf("请重新同步后继续使用");
  assert.ok(syncAt !== -1 && fallbackAt !== -1 && syncAt < fallbackAt);
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
  assert.match(branches[1], /error\("托管浏览器已关闭", "安全监控中断，请重新打开平台；托管账号凭据未被标记为失效"\)/);
  assert.match(branches[2], /error\("托管浏览器关闭未确认", "安全监控中断，请手动关闭对应浏览器后重试"\)/);
  assert.doesNotMatch(subscription, /\b(?:info|success)\(/);
});

test("local guard faults close the browser and return before credential reporting", () => {
  const commands = readFileSync(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  const watch = commands.slice(commands.indexOf("async fn watch_managed_logout"));
  const failureStart = watch.indexOf("if !matches!(detected, Ok(true))");
  const eventAt = watch.indexOf('"managed-session-guard-failed"');
  const reportAt = watch.indexOf(".report_managed_session_expired(");
  assert.ok(failureStart >= 0 && eventAt > failureStart && reportAt > eventAt);
  const failure = watch.slice(failureStart, watch.indexOf("return;", eventAt) + "return;".length);
  assert.match(failure, /kill_managed_browser\(context\.browsers\.clone\(\), context\.browser_id\)/);
  assert.match(failure, /current_identity\(\)/);
  assert.match(failure, /generation == context\.auth_generation/);
  assert.match(failure, /"browserClosed": closed/);
  assert.match(failure, /"monitor_disconnected"/);
  assert.match(failure, /"monitor_failed"/);
  assert.doesNotMatch(failure, /report_managed_session_expired|wait_managed_recovery|\.mark_error\(/);
  assert.match(failure, /return;\s*$/);
});

test("guard initialization failure returns before cookie injection", () => {
  const commands = readFileSync(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  const start = commands.indexOf("match managed_cdp::prepare_logout_watch");
  const inject = commands.indexOf("managed_cdp::inject_session", start);
  assert.ok(start >= 0 && inject > start);
  const prepare = commands.slice(start, inject);
  assert.match(prepare, /Err\(_\) => return Err\(CommandError::new\(/);
  assert.match(prepare, /"managed_guard_unavailable"/);
  assert.match(prepare, /managed_guard = true/);
  assert.doesNotMatch(prepare, /eprintln!|error\.to_string\(\)/);
});

test("guard failure listeners ignore inactive effects and clean up late subscriptions", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const subscription = guardFailedSubscription(app);
  assert.match(app, /let unlistenGuardFailedFn: \(\(\) => void\) \| undefined;/);
  assert.match(subscription, /\.onManagedSessionGuardFailed\(\(payload\) => \{\s*if \(!active\) return;/);
  assert.match(subscription, /\.then\(\(unlisten\) => \{\s*if \(active\) unlistenGuardFailedFn = unlisten;\s*else unlisten\(\);\s*\}\)/);
  assert.match(subscription, /\.catch\(\(\) => \{/);

  const cleanupStart = app.indexOf("\n    return () => {", app.indexOf(".onManagedSessionGuardFailed"));
  const cleanupEnd = app.indexOf("\n  }, [", cleanupStart);
  assert.ok(cleanupStart !== -1 && cleanupEnd > cleanupStart);
  const cleanup = app.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /active = false;/);
  assert.match(cleanup, /if \(unlistenGuardFailedFn\) unlistenGuardFailedFn\(\);/);
  assert.ok(cleanup.indexOf("active = false;") < cleanup.indexOf("unlistenGuardFailedFn();"));
});
