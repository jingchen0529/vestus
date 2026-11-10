import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./desktopConfigSync.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { createDesktopConfigSync } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const config = {
  proxy_assigned: true,
  proxy_ip: "203.0.113.27",
  platforms: [{ id: 7, name: "平台" }],
  direct_hosts: [],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("initial and focus refreshes share one pending desktop config request", async () => {
  const response = deferred();
  const applied = [];
  let requests = 0;
  const sync = createDesktopConfigSync({
    syncConfig: () => {
      requests += 1;
      return response.promise;
    },
    onConfig: (value) => applied.push(value),
  });

  const initial = sync.sync();
  const focus = sync.sync();
  assert.equal(requests, 1, "overlapping refreshes must not dispatch another IPC sync");
  response.resolve(config);
  assert.deepEqual(await Promise.all([initial, focus]), [true, true]);
  assert.deepEqual(applied, [config], "one synchronization updates the UI once");
});

test("logout or account replacement discards late config and keeps the new request coalesced", async () => {
  const oldResponse = deferred();
  const newResponse = deferred();
  const applied = [];
  let requests = 0;
  const sync = createDesktopConfigSync({
    syncConfig: () => (++requests === 1 ? oldResponse.promise : newResponse.promise),
    onConfig: (value) => applied.push(value),
  });

  const oldLogin = sync.sync();
  sync.invalidate();
  const newLogin = sync.sync();
  oldResponse.resolve({ ...config, platforms: [{ id: 1, name: "旧账号" }] });
  assert.equal(await oldLogin, false, "a revoked login cannot report successful synchronization");
  assert.deepEqual(applied, [], "late results cannot replace the current account's view");

  const focus = sync.sync();
  assert.equal(requests, 2, "old completion must not clear the new login's pending request");
  newResponse.resolve(config);
  assert.deepEqual(await Promise.all([newLogin, focus]), [true, true]);
  assert.deepEqual(applied, [config]);
});

test("network or server refresh failures keep the last config and allow a fresh retry", async () => {
  const failure = { code: "network", message: "暂时无法连接桌面服务" };
  const applied = [];
  const errors = [];
  const loading = [];
  let attempts = 0;
  let displayedConfig = null;
  const sync = createDesktopConfigSync({
    syncConfig: async () => {
      attempts += 1;
      if (attempts === 2) throw failure;
      return config;
    },
    onConfig: (value) => {
      displayedConfig = value;
      applied.push(value);
    },
    onError: (reason) => errors.push(reason),
    onLoading: (value) => loading.push(value),
  });

  assert.equal(await sync.sync(), true);
  assert.equal(await sync.sync(), false, "refresh errors resolve false rather than rejecting void callers");
  assert.equal(displayedConfig, config, "a transient failure must not erase usable platform entries");
  assert.deepEqual(errors, [failure]);
  assert.equal(await sync.sync(), true, "a failed attempt must not poison future refreshes");
  assert.deepEqual(applied, [config, config]);
  assert.deepEqual(loading, [true, false, true, false, true, false]);
});

test("a late status refresh cannot overwrite the next login's status or loading state", async () => {
  const oldStatus = deferred();
  const statuses = [];
  const loading = [];
  const currentStatus = { phase: "browser_running", message: "新账号", browser_open: true };
  let statusRequests = 0;
  const sync = createDesktopConfigSync({
    syncConfig: async () => config,
    getStatus: () => (++statusRequests === 1 ? oldStatus.promise : Promise.resolve(currentStatus)),
    onConfig: () => {},
    onStatus: (value) => statuses.push(value),
    onLoading: (value) => loading.push(value),
  });

  const oldLogin = sync.sync();
  await Promise.resolve();
  assert.equal(statusRequests, 1, "status refresh is part of the guarded synchronization");
  sync.invalidate();
  assert.equal(await sync.sync(), true);
  oldStatus.resolve({ phase: "ready", message: "旧账号", browser_open: false });
  assert.equal(await oldLogin, false);
  assert.deepEqual(statuses, [currentStatus]);
  assert.deepEqual(loading, [true, true, false], "old completion cannot clear new loading state");
});

test("an explicit refresh joining initialization announces the shared success only once", async () => {
  const response = deferred();
  const announcements = [];
  const sync = createDesktopConfigSync({
    syncConfig: () => response.promise,
    onConfig: () => {},
    onSuccess: (value, announce) => { if (announce) announcements.push(value); },
  });
  const initial = sync.sync(false);
  const refresh = sync.sync(true);
  const repeated = sync.sync(true);
  response.resolve(config);
  await Promise.all([initial, refresh, repeated]);
  assert.deepEqual(announcements, [config]);
});

// Execute the actual event subscriber at the approved IPC/UI seam, without a React test runtime.
function eventHandler(method, bindings) {
  const app = ts.createSourceFile(
    "App.tsx",
    readFileSync(new URL("../App.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handler;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === method) handler = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.ok(handler, `${method} must be subscribed by App`);
  const { outputText } = ts.transpileModule(`const handler = ${handler.getText(app)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn handler;`)(...Object.values(bindings));
}

test("automatic recovery does not reopen or announce success when config synchronization fails", async () => {
  const opened = [];
  const notices = [];
  const failures = [];
  const sync = createDesktopConfigSync({
    syncConfig: async () => { throw { code: "server", message: "服务暂不可用" }; },
    onConfig: () => {},
    onError: (reason) => failures.push(reason),
  });
  const recover = eventHandler("onManagedSessionRecovered", {
    active: true,
    isActive: () => true,
    syncDesktopConfig: () => sync.sync(),
    tauriBridge: { openBrowser: async (...args) => opened.push(args) },
    localStorage: { getItem: () => null },
    info: (...args) => notices.push(args),
    success: (...args) => notices.push(args),
    error: () => {},
  });

  recover({ recovered: true, platformId: 7, managedAccountId: 9 });
  await new Promise(setImmediate);
  assert.equal(failures.length, 1);
  assert.deepEqual(opened, [], "failed sync must not dispatch open_browser");
  assert.deepEqual(notices, [], "failed sync must not announce recovery success");
});

test("config change events during a failed refresh queue one successful follow-up without looping", async () => {
  const first = deferred();
  const second = deferred();
  const applied = [];
  let requests = 0;
  const sync = createDesktopConfigSync({
    syncConfig: () => (++requests === 1 ? first.promise : second.promise),
    onConfig: (value) => applied.push(value),
  });
  const changed = eventHandler("onStatusChange", {
    isActive: () => true,
    setStatus: () => {},
    syncDesktopConfig: (announce, afterPending) => afterPending
      ? sync.syncAfterPending()
      : sync.sync(announce),
    info: () => {},
  });
  const event = { error_code: "desktop_config_changed" };

  const initial = sync.sync();
  changed(event);
  changed(event);
  const focus = sync.sync();
  assert.equal(requests, 1, "events wait for the current request; focus still coalesces");
  first.reject({ code: "desktop_config_changed", message: "配置探测期间租约已变化" });
  assert.deepEqual(await Promise.all([initial, focus]), [false, false]);
  await new Promise(setImmediate);
  assert.equal(requests, 2, "the config change must not be lost with the failed in-flight request");

  const followUp = sync.syncAfterPending();
  changed(event);
  second.resolve(config);
  assert.equal(await followUp, true);
  await new Promise(setImmediate);
  assert.deepEqual(applied, [config]);
  assert.equal(requests, 2, "events during the follow-up must not create a retry loop");
});
