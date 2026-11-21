// check-surface-boundaries 的隔离回归。所有 mutation 都直接基于真实生产源，
// 避免合成 fixture 与实现漂移（2026-11-21 起废弃手工合成 collector 副本）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";

const policyPath = "desktop/src-tauri/src/managed_cdp.rs";
const guardPath = "desktop/src-tauri/src/managed_cdp/login_guard.js";
const cdpPath = "desktop/src-tauri/src/cdp.rs";
const browserPath = "desktop/src-tauri/src/browser.rs";
const commandsPath = "desktop/src-tauri/src/commands/browser.rs";

const realCache = new Map();
function realSource(path) {
  if (!realCache.has(path)) {
    realCache.set(
      path,
      readFileSync(new URL(path.replace(/^desktop\//, "../"), import.meta.url), "utf8"),
    );
  }
  return realCache.get(path);
}

const checkerSource = readFileSync(
  new URL("./check-surface-boundaries.mjs", import.meta.url),
  "utf8",
);

function writeFixture(root, relativePath, contents) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function runChecker(overrides = {}, { managed = false, eol = "\n" } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "vestus-surface-"));
  try {
    const sources = {
      "web/admin.html": "/api/admin/auth/login",
      "desktop/src-tauri/src/auth.rs": [
        "pub struct DesktopUser {}",
        "impl DesktopUser {}",
        '"/api/user/auth/login"',
        '"/api/user/auth/me"',
        '"/api/user/auth/logout"',
      ].join("\n"),
      "desktop/src-tauri/src/lib.rs": managed ? "mod managed_cdp;" : "",
      [cdpPath]: realSource(cdpPath),
      [browserPath]: realSource(browserPath),
      "desktop/src/App.tsx": "",
      "desktop/src/components/auth/LoginCard.tsx": "",
      "desktop/src/components/auth/ChangePasswordCard.tsx": "",
      "desktop/src/components/browser/PlatformLauncher.tsx": "",
      "desktop/src/components/layout/Header.tsx": "",
      "desktop/src/services/authService.ts": "",
      "desktop/src/services/tauriBridge.ts": "",
      "desktop/dist/assets/index.js": [
        "desktop_login", "desktop_restore_session", "desktop_logout",
        "desktop_product_name", "desktop_product_info", "desktop_change_password",
        "sync_desktop_config", "open_browser", "get_status",
      ].join(" "),
    };
    for (const name of readdirSync(new URL("../src-tauri/src/commands/", import.meta.url))) {
      if (!name.endsWith(".rs") || name === "tests.rs") continue;
      sources[`desktop/src-tauri/src/commands/${name}`] = realSource(
        `desktop/src-tauri/src/commands/${name}`,
      );
    }
    if (managed) {
      sources[policyPath] = realSource(policyPath);
      sources[guardPath] = realSource(guardPath);
    }
    for (const [path, source] of Object.entries(overrides)) {
      if (source === null) delete sources[path];
      else sources[path] = source;
    }
    writeFixture(fixture, "desktop/scripts/check-surface-boundaries.mjs", checkerSource);
    for (const [path, source] of Object.entries(sources)) {
      writeFixture(fixture, path, source.replace(/\r\n?|\n/g, eol));
    }
    return spawnSync(
      process.execPath,
      [join(fixture, "desktop/scripts/check-surface-boundaries.mjs")],
      { encoding: "utf8", timeout: 10_000 },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function passes(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /surface boundaries: ok/);
}

function fails(result, expected) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, "boundary bypass unexpectedly passed");
  assert.match(result.stderr, expected);
}

function change(path, from, to) {
  const source = realSource(path);
  assert.equal(
    source.split(from).length - 1,
    1,
    `fixture mutation must be unique in ${path}: ${from}`,
  );
  return { [path]: source.replace(from, to) };
}

// Scoped mutation within one function body of a real production file.
function changeFunction(name, from, to, path = cdpPath) {
  const source = realSource(path);
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `fixture function not found: ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  let inString = false;
  let stringChar = "";
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const prev = source[index - 1];
    if (inString) {
      if (char === stringChar && prev !== "\\") inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `fixture function end not found: ${name}`);
  const body = source.slice(start, end);
  assert.equal(
    body.split(from).length - 1,
    1,
    `mutation must be unique within ${name}: ${from}`,
  );
  return { [path]: source.slice(0, start) + body.replace(from, to) + source.slice(end) };
}

// Exercise the real collector against synthetic non-CDP surfaces so stale build
// artifacts cannot conceal a mismatch between this checker and production.
test("current production collector satisfies managed surface invariants", () => {
  passes(runChecker({}, { managed: true }));
});

for (const [name, from, to] of [
  ["missing tracked detached verifier", "CloseRequest::Detached(target));", "CloseRequest::Detached(other_target));"],
  ["detached verifier omitted from shared absence validation", "CloseRequest::Verify(target) | CloseRequest::Detached(target) =>", "CloseRequest::Verify(target) =>"],
  ["detached cleanup notification emitted for user close", ".filter(|closed| closed.notify)", ""],
  ["detached initial target failure not fail closed", /if\s+closing\.initial\s*\{\s*out\.guard_failed\s*=\s*true;\s*return;\s*\}/, "if false { out.guard_failed = true; return; }"],
]) {
  test(`current production detach boundary rejects ${name}`, () => {
    const source = realSource(cdpPath);
    const count = from instanceof RegExp ? [...source.matchAll(new RegExp(from.source, "g"))].length : source.split(from).length - 1;
    assert.equal(count, 1, `production mutation must be unique: ${from}`);
    fails(runChecker({ [cdpPath]: source.replace(from, to) }, { managed: true }), /canonical detach 必须/);
  });
}

test("surface checker isolates chromium_arguments in a Windows CRLF checkout", () => {
  passes(runChecker({}, { eol: "\r\n" }));
});

for (const eol of ["\n", "\r\n"]) {
  test(`single-connection managed guard passes with ${JSON.stringify(eol)} line endings`, () => {
    passes(runChecker({}, { managed: true, eol }));
  });
}

test("ACK boundary accepts rustfmt trailing commas without weakening quoted values", () => {
  passes(runChecker({
    [cdpPath]: realSource(cdpPath)
      .replace('commands.push(self.command(Some(session_id), "Page.enable", json!({})));', 'commands.push(self.command(Some(session_id), "Page.enable", json!({}),));')
      .replace('kind(session_id.to_string()));', 'kind(session_id.to_string()),\n        );')
      .replace('"source": state.login_guard_script.clone(), "runImmediately": true})', '"source": state.login_guard_script.clone(), "runImmediately": true,})')
      .replace('self.acknowledge_guard(id, &message, &mut out);', 'self.acknowledge_guard(id, &message, &mut out,);')
      .replace('self.acknowledge_close(id, &message, &mut out);', 'self.acknowledge_close(id, &message, &mut out,);'),
  }, { managed: true }));
});

test("guard accepts policy URL checks, style writes and harmless formatting changes", () => {
  passes(runChecker({
    [policyPath]: realSource(policyPath)
      .replace('"origin": self.login_route.origin().ascii_serialization(),\n                "path": self.login_route.path(),', '"path": self.login_route.path(),\n                "origin": self.login_route.origin().ascii_serialization(),'),
    [guardPath]: realSource(guardPath) + "\n// Never read document.cookie or call fetch().\n",
  }, { managed: true }));
});

test("local test items may use Runtime and do not hide later production code", () => {
  const localTest = `
#[cfg ( test )]
#[allow(dead_code)]
fn local_fake() { send("Runtime.evaluate", r#"{ \\\"fake\\\": true }"#); }
#[cfg(test)]
#[path = "integration_tests.rs"]
mod integration_tests;
#[cfg(test)]
mod tests { fn input() { send("Input.dispatchKeyEvent"); } }
`;
  passes(runChecker({
    [policyPath]: localTest + realSource(policyPath),
    [cdpPath]: localTest + realSource(cdpPath),
    [commandsPath]: localTest + realSource(commandsPath),
  }, { managed: true, eol: "\r\n" }));
  fails(runChecker({
    [cdpPath]: localTest + realSource(cdpPath).replace(
      "fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {",
      'fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> { send("Runtime.evaluate");',
    ),
    [policyPath]: localTest + realSource(policyPath),
    [commandsPath]: localTest + realSource(commandsPath),
  }, { managed: true, eol: "\r\n" }), /只读采集用不着的能力/);
});

for (const [name, extra, expected] of [
  ["cookie property", "document.cookie", /Cookie\/凭据或浏览器存储/],
  ["cookie bracket access", "document['cookie']", /Cookie\/凭据或浏览器存储/],
  ["local storage", "window.localStorage.getItem('token')", /Cookie\/凭据或浏览器存储/],
  ["form value", "event.target.value", /DOM 字段或表单值/],
  ["form bracket value", "input['value']", /DOM 字段或表单值/],
  ["form data", "new FormData(document.forms[0])", /DOM 字段或表单值/],
  ["network fetch", "fetch('/session')", /网络或外部资源请求/],
  ["XHR", "new XMLHttpRequest()", /网络或外部资源请求/],
  ["beacon", "navigator.sendBeacon('/session', 'data')", /网络或外部资源请求/],
  ["dynamic execution", "eval(window.frontendScript)", /动态脚本执行/],
  ["frontend placeholder", "const source = __FRONTEND_SCRIPT__", /只能包含一个 origin\/path/],
]) {
  test(`fixed guard rejects ${name}`, () => {
    fails(runChecker({ [guardPath]: realSource(guardPath) + `\n${extra};\n` }, { managed: true }), expected);
  });
}

for (const [name, from, to, expected] of [
  ["frontend policy source", 'include_str!("managed_cdp/login_guard.js")', "frontend_script", /只能编译固定脚本/],
  ["extra template data", '"path": self.login_route.path(),', '"path": self.login_route.path(), "source": frontend_script,', /只能编译固定脚本/],
  ["frontend route", 'Url::parse("https://agent.oceanengine.com/login")', "Url::parse(target_url)", /固定方舟 policy/],
  ["producer outside the fixed policy", "LogoutPolicy::for_platform(target_url).map(|policy| policy.login_guard_script())", "Some(frontend_script)", /必须由固定 policy 生成/],
]) {
  test(`managed boundary rejects ${name}`, () => {
    fails(runChecker(change(policyPath, from, to), { managed: true }), expected);
  });
}

for (const [name, from, to, expected] of [
  ["extension manifest runs isolated", '"world": "MAIN",', '"world": "ISOLATED",', /扩展目录只能由 policy 生成/],
  ["extension generation skips fail closed", "std::io::ErrorKind::InvalidInput,", "std::io::ErrorKind::Other,", /扩展目录只能由 policy 生成/],
  ["extension guard produced outside policy", 'std::fs::write(extension_dir.join("guard.js"), policy.login_guard_script())?;', 'std::fs::write(extension_dir.join("guard.js"), frontend_script)?;', /扩展目录只能由 policy 生成/],
]) {
  test(`preinstalled extension boundary rejects ${name}`, () => {
    fails(runChecker(change(policyPath, from, to), { managed: true }), expected);
  });
}

test("launch boundary rejects an unconditional load-extension switch", () => {
  fails(runChecker(change(browserPath, "if let Some(extension) = login_guard_extension {", "if true {"), { managed: true }), /chromium_arguments 必须只在提供扩展目录时追加/);
});

test("command boundary rejects a downgraded extension failure", () => {
  fails(runChecker(change(commandsPath, "BrowserError::LoginGuardExtension(_)", "BrowserError::ProfileBusy(_)"), { managed: true }), /扩展准备失败必须 fail closed/);
});

for (const [name, from, to, expected] of [
  ["dynamic install source", 'state.login_guard_script.clone()', 'frontend.script.clone()', /只能来自 policy|policy 生成的固定字段/],
  ["missing guard install", '"source": state.login_guard_script.clone()', '"source": arbitrary_script', /只能来自 policy|policy 生成的固定字段/],
  ["an extra document script", 'commands.push(self.command(Some(session_id), "Page.getFrameTree", json!({})));', 'commands.push(self.command(Some(session_id), "Page.addScriptToEvaluateOnNewDocument", json!({"source": extra})));\n        commands.push(self.command(Some(session_id), "Page.getFrameTree", json!({})));', /只允许安装托管固定 guard/],
  ["guard after Page.enable", '"Page.enable", json!({})));', '"Page.enableLater", json!({})));', /Page\.enable 之前/],
  ["managed pauses new targets again", '"waitForDebuggerOnStart": wait_for_debugger', '"waitForDebuggerOnStart": true', /托管必须关闭 debugger 暂停/],
  ["self-contained guard script", "pub(crate) struct ManagedWatch {", 'const RAW: &str = include_str!("managed_cdp/login_guard.js");\npub(crate) struct ManagedWatch {', /只能在 managed_cdp 的 policy 里生成/],
  ["collapsed failure signals", "ConnectionLost,", "", /必须区分凭据过期与防护连接断开/],
]) {
  test(`managed boundary rejects ${name}`, () => {
    fails(runChecker(change(cdpPath, from, to), { managed: true }), expected);
  });
}

test("boundary rejects the deadlocked pause machinery returning", () => {
  fails(runChecker(change(cdpPath, "    Monitor(String),", "    Monitor(String),\n    Resume(String),"), { managed: true }), /暂停状态机不得回归/);
});

for (const [name, fn, from, to, expected] of [
  ["disabled lifecycle", "install", '"enabled": true', '"enabled": false', /必须订阅 lifecycle/],
  ["guard not covering existing document", "install", '"runImmediately": true', '"runImmediately": false', /只能来自 policy|policy 生成的固定字段/],
  ["missing initial ACK registration", "install", 'tracked(self, GuardRequest::Install);', '/* untracked */', /五条 Install ACK/],
  ["resume ACK excluded from initial latch", "install", 'commands.push(self.resume_page(session_id));\n            tracked(\n                self,\n                if initial {\n                    GuardRequest::Install\n                } else {\n                    GuardRequest::Monitor\n                },\n            );', 'commands.push(self.resume_page(session_id));', /五条 Install ACK/],
  ["ACK handler not dispatched", "handle", 'self.acknowledge_guard(id, &message, &mut out);', '/* missing dispatch */', /ACK handler 必须/],
  ["untracked ACK ID", "acknowledge_guard", 'self.guard_requests.get(&id)', 'self.guard_requests.values().next()', /ACK handler 必须/],
  ["wrong ACK session accepted", "acknowledge_guard", "!= session", "== session", /ACK handler 必须/],
  ["rejection does not stop local failure", "acknowledge_guard", "self.fail_page(session, reason, out);", "/* swallow */", /ACK handler 必须/],
  ["readiness while install ACK pending", "acknowledge_guard", 'if !pending {\n                    if let Some(page) = self.sessions.get_mut(&session) {', 'if true {\n                    if let Some(page) = self.sessions.get_mut(&session) {', /初始页全部安装回执完成即置就绪闩/],
  ["other page ACK clears pending installs", "acknowledge_guard", "if other == &session", "if true", /初始页全部安装回执完成即置就绪闩/],
  ["latch not marked for the initial target", "acknowledge_guard", "state.guard_installed.mark_for(&page.target_id);", "state.guard_installed.mark_for(&other_target);", /初始页全部安装回执完成即置就绪闩/],
  ["readiness not published", "acknowledge_guard", "out.guard_installed = true;", "", /初始页全部安装回执完成即置就绪闩/],
]) {
  test(`managed ACK boundary rejects ${name}`, () => {
    fails(runChecker(changeFunction(fn, from, to), { managed: true }), expected);
  });
}

for (const [name, from, to, expected] of [
  ["protocol error accepted", 'message.get("error").is_none()', "true", /ACK handler 必须/],
  ["malformed ACK result accepted", 'message.get("result").is_some_and(Value::is_object)', 'message.get("result").is_some()', /ACK handler 必须/],
]) {
  test(`managed ACK boundary rejects ${name}`, () => {
    fails(runChecker(changeFunction("acknowledge_guard", from, to), { managed: true }), expected);
  });
}

for (const [name, fn, from, to, expected] of [
  ["initial latch target inferred from any page", "on_attached", "state.guard_installed.is_initial_target(target_id)", "true", /初始 target 必须由就绪闩/],
  ["per-page deadline removed", "on_attached", "deadline: self.managed.as_ref().map(|_| {", "deadline: None, /* self.managed", /有界 deadline/],
  ["duplicate attachment resumes unguarded target", "on_attached", "if self.managed.is_some() {", "if false {", /重复追加 attachment/],
  ["repeated session resumes again", "on_attached", "if self.sessions.contains_key(&session_id) {\n            return;\n        }", "if self.sessions.contains_key(&session_id) {\n            out.commands.extend(self.resume_and_detach(&session_id));\n            return;\n        }", /重复追加 attachment/],
  ["timer no longer wakes on absent ACK", "collect_events", "if let Some(deadline) = setup_deadline {\n                    tokio::time::sleep_until(deadline).await;", "if let Some(deadline) = setup_deadline {\n                    std::future::pending::<()>().await;", /有界 deadline/],
  ["page expiry never handled", "expire_setup", "self.fail_page(&session, reason, &mut out);", "/* never expire */", /有界 deadline/],
  ["close timeout ignored", "expire_setup", "closing.deadline <= now", "false", /有界 deadline/],
  ["expiry reason misclassified", "expire_setup", '"guard_install_timeout"', '"monitor_install_timeout"', /有界 deadline/],
  ["deadline cleared while monitor ACK pending", "finish_popup_setup", "if !pending {", "if true {", /有界 deadline/],
  ["frame tree retention dropped", "finish_popup_setup", "page.deadline = None;\n                self.frame_tree_requests\n                    .retain(|_, session| session != session_id);", "page.deadline = None;", /有界 deadline/],
  ["wrong session monitor ACK clears deadline", "finish_popup_setup", "if session == session_id", "if true", /有界 deadline/],
  ["initial failure treated as scoped page closure", "fail_page", "if page.initial {", "if false {", /初始失败必须 fail closed/],
  ["unrelated sessions removed on additional failure", "fail_page", "page.target_id == target", "true", /清理同 target session/],
  ["wrong target closed", "fail_page", '"targetId": target', '"targetId": other_target', /只能关闭所属 target/],
  ["close request untracked", "fail_page", "self.close_requests\n            .insert(self.next_id, CloseRequest::Close(target));", "/* untracked close */", /只能关闭所属 target/],
  ["untracked close ACK accepted", "acknowledge_close", "self.close_requests.get(&id)", "self.close_requests.values().next()", /关闭验证必须核对请求 ID/],
  ["session-level close ACK accepted", "acknowledge_close", 'if message.get("sessionId").is_some() {\n            return;\n        }', "", /关闭验证必须核对请求 ID/],
  ["close ACK treated as proof of absence", "acknowledge_close", 'out.commands\n                    .push(self.command(None, "Target.getTargets", json!({})));', "self.closing_targets.remove(&target);", /关闭验证必须核对请求 ID/],
  ["wrong target bound to close verification", "acknowledge_close", "CloseRequest::Verify(target));", "CloseRequest::Verify(other_target));", /关闭验证必须核对请求 ID/],
  ["close verification allows protocol error", "acknowledge_close", 'message.get("error").is_none()', "true", /关闭验证必须核对请求 ID/],
  ["malformed target list proves absence", "acknowledge_close", "Value::as_array", "Value::as_object", /关闭验证必须核对请求 ID/],
  ["malformed target ID proves absence", "acknowledge_close", "!id.is_empty()", "true", /关闭验证必须核对请求 ID/],
  ["wrong target absence proves closure", "acknowledge_close", "== Some(&target)", "== Some(&other_target)", /关闭验证必须核对请求 ID/],
  ["still-present target reported closed", "acknowledge_close", "                    return;\n                }\n                if let Some(closed) = self", "                }\n                if let Some(closed) = self", /target 仍存在时必须退出/],
  ["wrong closure state consumed", "acknowledge_close", "self\n                    .closing_targets\n                    .remove(&target)", "self\n                    .closing_targets\n                    .remove(&other_target)", /关闭验证必须核对请求 ID/],
  ["close ACK handler not dispatched", "handle", "self.acknowledge_close(id, &message, &mut out);", "/* no close dispatch */", /关闭验证必须核对请求 ID/],
  ["second long-lived guard connection", "resume_and_detach", "fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {", 'fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> { let second = connect(&endpoint);', /唯一长连接/],
]) {
  test(`managed liveness boundary rejects ${name}`, () => {
    fails(runChecker(changeFunction(fn, from, to), { managed: true }), expected);
  });
}

test("bounded scoped close polling rejects deadline renewal", () => {
  fails(runChecker(change(cdpPath, "closing.retry_at =\n                            Some(tokio::time::Instant::now() + Duration::from_millis(100));", "closing.deadline = tokio::time::Instant::now() + crate::managed_cdp::GUARD_INSTALL_TIMEOUT; closing.retry_at = Some(tokio::time::Instant::now() + Duration::from_millis(100));"), { managed: true }), /关闭验证不得续期/);
});

test("collector rejects an extra raw debugger resume outside release helpers", () => {
  fails(runChecker(change(cdpPath, '"Target.attachedToTarget" => self.on_attached(params, &mut out),', '"Target.attachedToTarget" => self.on_attached(params, &mut out),\n            "__vestus_probe__" => out.commands.push(self.command(Some("probe"), "Runtime.runIfWaitingForDebugger", json!({}))),'), { managed: true }), /resume 回执只参与初始就绪闩与后续页预算/);
});

test("additional page cannot bypass policy source through a helper", () => {
  fails(runChecker(changeFunction("resume_and_detach", "fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {", 'fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> { out.commands.push(self.command(Some(session_id), "Page.addScriptToEvaluateOnNewDocument", json!({"source": frontend})));'), { managed: true }), /只允许安装托管固定 guard/);
});

test("managed boundary rejects page scripting in the policy module", () => {
  fails(
    runChecker({ [policyPath]: realSource(policyPath) + '\nfn bypass() { send("Runtime.evaluate"); }' }, { managed: true }),
    /不得自行发送页面命令/,
  );
});

for (const [name, extra, expected] of [
  ["page scripting in the command layer", '\nfn bypass() { send("Runtime.evaluate"); }', /不得绕开采集连接执行页面脚本或输入命令/],
  ["self-installed document scripts", '\nfn bypass() { send("Page.addScriptToEvaluateOnNewDocument"); }', /不得绕开采集连接执行页面脚本或输入命令|不得自带 guard 模板/],
  ["a second guard script source", '\nfn peek(other: ManagedWatch) { let stolen = other.login_guard_script; }', /只能通过 managed_cdp::logout_guard_script/],
]) {
  test(`command layer rejects ${name}`, () => {
    fails(runChecker({ [commandsPath]: realSource(commandsPath) + extra }, { managed: true }), expected);
  });
}

for (const method of ["Runtime.evaluate", "Runtime.callFunctionOn", "Input.dispatchKeyEvent", "Network.getCookies", "Storage.getCookies", "Fetch.enable", "Page.navigate"]) {
  test(`collector cannot acquire ${method}`, () => {
    fails(runChecker({
      [cdpPath]: realSource(cdpPath).replace(
        "fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {",
        `fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> { send("${method}");`,
      ),
    }, { managed: true }), /采集通道拿到了只读采集用不着的能力/);
  });
}

for (const method of ["Runtime.enable", "Runtime.addBinding", "Runtime.bindingCalled"]) {
  test(`address-only collection rejects ${method}`, () => {
    fails(runChecker(change(cdpPath,
      'self.command(Some(session_id), "Page.enable", json!({})));',
      `self.command(Some(session_id), "Page.enable", json!({}))), self.command(Some(session_id), "${method}", json!({})));`,
    ), { managed: true }), /只读采集用不着的能力/);
  });
}

test("collector I/O helper cannot bypass the read-only capability boundary", () => {
  fails(runChecker(change(cdpPath, "let socket = connect(&endpoint).await?;",
    'let socket = connect(&endpoint).await?; send("Runtime.enable");'), { managed: true }),
    /只读采集用不着的能力/);
});

for (const path of [policyPath, guardPath]) {
  test(`partial managed fixture cannot omit ${path}`, () => {
    fails(runChecker({ [path]: null }, { managed: true }), /必须包含固定脚本与 policy/);
  });
}

test("compiled managed module cannot omit all guard files", () => {
  fails(runChecker({ "desktop/src-tauri/src/lib.rs": "mod managed_cdp;" }), /必须包含固定脚本与 policy/);
});
