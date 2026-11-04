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
  // 非Expired 分支（ConnectionLost/None）就是本地故障路径。
  const lostStart = watch.indexOf("other => {");
  const eventAt = watch.indexOf('"managed-session-guard-failed"', lostStart);
  const reportAt = watch.indexOf(".report_managed_session_expired(");
  assert.ok(lostStart >= 0 && eventAt > lostStart, "断连故障必须发 guard-failed 事件");
  const lostBranch = watch.slice(lostStart, watch.indexOf("return;", eventAt) + "return;".length);
  assert.match(lostBranch, /kill_managed_browser\(context\.browsers\.clone\(\), context\.browser_id\)/);
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

test("expired signals run the full credential reporting flow", () => {
  const commands = readFileSync(new URL("../src-tauri/src/commands/managed.rs", import.meta.url), "utf8");
  const watch = commands.slice(commands.indexOf("async fn run_managed_watch"));
  const expiredAt = watch.indexOf("ManagedSignal::Expired");
  assert.ok(expiredAt >= 0);
  const flow = watch.slice(expiredAt);
  assert.match(flow, /kill_managed_browser\(context\.browsers\.clone\(\), context\.browser_id\)/);
  assert.match(flow, /report_managed_session_expired/);
  assert.match(flow, /"managed-session-expired"/);
  assert.match(flow, /wait_managed_recovery/);
});

test("collector drives the managed watch with a single CDP client", () => {
  const browser = readFileSync(new URL("../src-tauri/src/commands/browser.rs", import.meta.url), "utf8");
  const injectAt = browser.indexOf("managed_cdp::inject_session");
  const spawnAt = browser.indexOf("run_managed_watch(");
  const startAt = browser.indexOf("activity_collector.start(");
  assert.ok(spawnAt >= 0 && spawnAt < injectAt, "监控消费端必须在注入前启动");
  assert.ok(injectAt < startAt, "活动采集（含防护信号）必须在注入成功后启动");
  assert.doesNotMatch(browser, /prepare_logout_watch/);

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
