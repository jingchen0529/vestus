import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const checkerSource = readFileSync(
  new URL("./check-surface-boundaries.mjs", import.meta.url),
  "utf8",
);
const policyPath = "desktop/src-tauri/src/managed_cdp.rs";
const guardPath = "desktop/src-tauri/src/managed_cdp/login_guard.js";
const cdpPath = "desktop/src-tauri/src/cdp.rs";
const commandsPath = "desktop/src-tauri/src/commands.rs";

// Small independent source fixtures: no build output, browser, credentials, or
// production source snapshots are needed to exercise the checker.
const managedSources = {
  [policyPath]: `
struct LogoutPolicy { login_route: Url }
impl LogoutPolicy {
    fn for_platform(target_url: &str) -> Option<Self> {
        Some(Self {
            login_route: Url::parse("https://agent.oceanengine.com/login").unwrap(),
        })
    }
    fn login_guard_script(&self) -> String {
        include_str!("managed_cdp/login_guard.js").replace(
            "__VESTUS_LOGIN_ROUTE__",
            &json!({
                "origin": self.login_route.origin().ascii_serialization(),
                "path": self.login_route.path(),
            }).to_string(),
        )
    }
}
pub(crate) fn logout_guard_script(target_url: &str) -> Option<String> {
    LogoutPolicy::for_platform(target_url).map(|policy| policy.login_guard_script())
}
`,
  [guardPath]: `
(() => {
  const route = __VESTUS_LOGIN_ROUTE__;
  const url = new URL(location.href);
  if (window.top !== window || location.origin !== route.origin) return;
  const isLogin = !url.username && !url.password && url.origin === route.origin
    && (url.pathname === route.path || url.pathname.startsWith(\`\${route.path}/\`));
  if (isLogin) {
    document.documentElement.style.setProperty('opacity', '0', 'important');
    document.documentElement.inert = true;
  }
  Object.defineProperty(window, '__guard', { value: true });
})();
`,
  // 单连接模型：订阅地址，安装托管固定 guard 后放行。
  [cdpPath]: `
struct ManagedWatch { login_guard_script: String }
pub enum ManagedSignal { Expired, ConnectionLost }
struct Collector { managed: Option<ManagedWatch> }
pub async fn collect(managed: Option<ManagedWatch>) {
    let collector = Collector { managed };
}
impl Collector {
    fn opening_commands(&mut self) -> Vec<String> {
        vec![self.command(None, "Target.setAutoAttach", json!({
            "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true,
        }))]
    }
    fn install(&mut self, session_id: &str) -> Vec<String> {
        let managed = self.managed.as_ref().map(|state| state.login_guard_script.clone());
        let mut commands = Vec::new();
        if let Some(source) = managed {
            self.guard_requests.insert(self.next_id, GuardRequest::Install(session_id.to_string()));
            commands.push(self.command(Some(session_id), "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": source, "runImmediately": true})));
        }
        commands.push(self.command(Some(session_id), "Page.enable", json!({})));
        if self.managed.is_some() {
            self.guard_requests.insert(self.next_id, GuardRequest::Install(session_id.to_string()));
        }
        commands.push(self.command(Some(session_id), "Page.getFrameTree", json!({})));
        if self.managed.is_some() {
            self.guard_requests.insert(self.next_id, GuardRequest::Install(session_id.to_string()));
            commands.push(self.command(Some(session_id), "Page.setLifecycleEventsEnabled", json!({"enabled": true})));
            self.guard_requests.insert(self.next_id, GuardRequest::Install(session_id.to_string()));
        } else {
            commands.push(self.resume_page(session_id));
        }
        commands
    }
    fn resume_page(&mut self, session_id: &str) -> String {
        let command = self.command(Some(session_id), "Runtime.runIfWaitingForDebugger", json!({}));
        if self.managed.is_some() {
            self.guard_requests.insert(self.next_id, GuardRequest::Resume(session_id.to_string()));
        }
        command
    }
    fn acknowledge_guard(&mut self, id: i64, message: &Value, out: &mut Handled) {
        let Some(request) = self.guard_requests.get(&id).cloned() else { return };
        let session = match &request {
            GuardRequest::Install(session) | GuardRequest::Resume(session) => Some(session.as_str()),
            GuardRequest::AutoAttach => None,
        };
        if message.get("sessionId").and_then(Value::as_str) != session {
            return;
        }
        let accepted = message.get("error").is_none() && message.get("result").is_some_and(Value::is_object);
        if !accepted {
            out.guard_failed = true;
            return;
        }
        self.guard_requests.remove(&id);
        match request {
            GuardRequest::Install(session) => {
                let pending = self.guard_requests.values().any(|request| {
                    matches!(request, GuardRequest::Install(other) if other == &session)
                });
                if !pending && self.sessions.contains_key(&session) {
                    out.commands.push(self.resume_page(&session));
                }
            }
            GuardRequest::Resume(session) => {
                if let Some(page) = self.sessions.get(&session) {
                    if let Some(state) = self.managed.as_ref() {
                        state.guard_installed.mark_for(&page.target_id);
                    }
                    out.guard_installed = true;
                }
            }
            GuardRequest::AutoAttach => {}
        }
    }
    fn handle(&mut self, text: &str) -> Handled {
        self.acknowledge_guard(id, &message, &mut out);
        out
    }
    fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {
        vec![
            self.command(Some(session_id), "Runtime.runIfWaitingForDebugger", json!({})),
            self.command(None, "Target.detachFromTarget", json!({"sessionId": session_id})),
        ]
    }
}
`,
  [commandsPath]: `
struct ManagedWatch { login_guard_script: String }
fn build_watch(session: &Session) -> ManagedWatch {
    ManagedWatch {
        login_guard_script: managed_cdp::logout_guard_script(&session.target_url).expect("policy"),
    }
}
`,
};

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
      [cdpPath]: "",
      [commandsPath]: "",
      "desktop/src-tauri/src/browser.rs": [
        "fn chromium_arguments() {",
        '  let args = ["--remote-debugging-port=0"];',
        "}",
        "",
        "#[cfg(test)]",
        'const DOCUMENTED_FORBIDDEN: &str = "--remote-debugging-address";',
      ].join("\n"),
      ...Object.fromEntries([
        "desktop/src/App.tsx",
        "desktop/src/components/auth/LoginCard.tsx",
        "desktop/src/components/auth/ChangePasswordCard.tsx",
        "desktop/src/components/browser/PlatformLauncher.tsx",
        "desktop/src/components/layout/Header.tsx",
        "desktop/src/services/authService.ts",
        "desktop/src/services/tauriBridge.ts",
      ].map((path) => [path, ""])),
      "desktop/dist/assets/index.js": [
        "desktop_login", "desktop_restore_session", "desktop_logout",
        "desktop_product_name", "desktop_product_info", "desktop_change_password",
        "sync_desktop_config", "open_browser", "get_status",
      ].join(" "),
      ...(managed ? managedSources : {}),
      ...overrides,
    };
    writeFixture(fixture, "desktop/scripts/check-surface-boundaries.mjs", checkerSource);
    for (const [path, source] of Object.entries(sources)) {
      if (source !== null) writeFixture(fixture, path, source.replace(/\r\n?|\n/g, eol));
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
  assert.ok(managedSources[path].includes(from), `fixture mutation not found: ${from}`);
  return { [path]: managedSources[path].replace(from, to) };
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
    [cdpPath]: managedSources[cdpPath]
      .replaceAll('GuardRequest::Install(session_id.to_string()));', 'GuardRequest::Install(session_id.to_string()),\n            );')
      .replaceAll('GuardRequest::Resume(session_id.to_string()));', 'GuardRequest::Resume(session_id.to_string()),\n            );')
      .replace('"source": source, "runImmediately": true}', '"source": source, "runImmediately": true,}')
      .replace('self.acknowledge_guard(id, &message, &mut out);', 'self.acknowledge_guard(id, &message, &mut out,);'),
  }, { managed: true }));
});

test("guard accepts policy URL checks, style writes and harmless formatting changes", () => {
  passes(runChecker({
    [policyPath]: managedSources[policyPath]
      .replace('"origin": self.login_route.origin().ascii_serialization(),\n                "path": self.login_route.path(),',
        '"path": self.login_route.path(), /* fixed route */\n                "origin": self.login_route.origin().ascii_serialization(),'),
    [guardPath]: managedSources[guardPath] + "\n// Never read document.cookie or call fetch().\n",
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
    [policyPath]: localTest + managedSources[policyPath],
    [cdpPath]: localTest + managedSources[cdpPath],
    [commandsPath]: localTest + managedSources[commandsPath],
  }, { managed: true, eol: "\r\n" }));
  fails(runChecker({
    [cdpPath]: localTest + managedSources[cdpPath].replace(
      "fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {",
      'fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> { send("Runtime.evaluate");',
    ),
  }, { managed: true }), /采集通道拿到了只读采集用不着的能力/);
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
    fails(runChecker({ [guardPath]: managedSources[guardPath] + `\n${extra};\n` }, { managed: true }), expected);
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
  ["dynamic install source", 'state.login_guard_script.clone()', 'frontend.script.clone()', /只能来自 policy|policy 生成的固定字段/],
  ["missing guard install", '"source": source', '"source": arbitrary_script', /policy 生成的固定字段/],
  ["an extra document script", 'commands.push(self.command(Some(session_id), "Page.getFrameTree"', 'commands.push(self.command(Some(session_id), "Page.addScriptToEvaluateOnNewDocument", json!({"source": extra})));\n        commands.push(self.command(Some(session_id), "Page.getFrameTree"', /只允许安装托管固定 guard/],
  ["guard after Page.enable", '"Page.enable"', '"Page.enableLater"', /Page\.enable 之前/],
  ["no debugger wait", '"waitForDebuggerOnStart": true', '"waitForDebuggerOnStart": false', /必须暂停新 target/],
  ["self-contained guard script", "struct ManagedWatch { login_guard_script: String }", 'struct ManagedWatch { login_guard_script: String }\nconst RAW: &str = include_str!("managed_cdp/login_guard.js");', /只能在 managed_cdp 的 policy 里生成/],
  ["collapsed failure signals", "pub enum ManagedSignal { Expired, ConnectionLost }", "pub enum ManagedSignal { Expired }", /必须区分凭据过期与防护连接断开/],
]) {
  test(`managed boundary rejects ${name}`, () => {
    fails(runChecker(change(cdpPath, from, to), { managed: true }), expected);
  });
}

for (const [name, from, to, expected] of [
  ["disabled lifecycle", '"enabled": true', '"enabled": false', /必须订阅 lifecycle/],
  ["guard not covering existing document", '"runImmediately": true', '"runImmediately": false', /runImmediately: true/],
  ["resume before install ACKs", 'commands.push(self.command(Some(session_id), "Page.getFrameTree"', 'commands.push(self.resume_page(session_id));\n        commands.push(self.command(Some(session_id), "Page.getFrameTree"', /不能在安装命令发送时放行/],
  ["missing install ACK registration", 'self.guard_requests.insert(self.next_id, GuardRequest::Install(session_id.to_string()));', '/* missing registration */', /必须登记四条 ACK/],
  ["ACK handler not dispatched", 'self.acknowledge_guard(id, &message, &mut out);', '/* missing dispatch */', /ACK handler 必须/],
  ["untracked ACK ID", 'self.guard_requests.get(&id)', 'self.guard_requests.values().next()', /ACK handler 必须/],
  ["wrong ACK session accepted", '!= session', '== session', /ACK handler 必须/],
  ["protocol error accepted", 'message.get("error").is_none()', 'true', /ACK handler 必须/],
  ["malformed ACK result accepted", 'message.get("result").is_some_and(Value::is_object)', 'message.get("result").is_some()', /ACK handler 必须/],
  ["rejection does not stop resume", 'out.guard_failed = true;\n            return;', 'out.guard_failed = true;', /ACK handler 必须/],
  ["resume while another install ACK pending", 'if !pending && self.sessions.contains_key(&session)', 'if self.sessions.contains_key(&session)', /全部安装请求完成后/],
  ["other page ACK clears pending installs", 'if other == &session', 'if true', /全部安装请求完成后/],
  ["untracked resume ACK", 'GuardRequest::Resume(session_id.to_string())', 'GuardRequest::AutoAttach', /成功的 page resume ACK/],
  ["wrong target satisfies readiness", 'mark_for(&page.target_id)', 'mark_for(&other_target)', /成功的 page resume ACK/],
  ["readiness published by install ACK", 'out.commands.push(self.resume_page(&session));', 'out.guard_installed = true; out.commands.push(self.resume_page(&session));', /全部安装请求完成后|成功的 page resume ACK/],
]) {
  test(`managed ACK boundary rejects ${name}`, () => {
    fails(runChecker(change(cdpPath, from, to), { managed: true }), expected);
  });
}

test("managed boundary rejects page scripting in the policy module", () => {
  fails(
    runChecker({ [policyPath]: managedSources[policyPath] + '\nfn bypass() { send("Runtime.evaluate"); }' }, { managed: true }),
    /不得自行发送页面命令/,
  );
});

for (const [name, extra, expected] of [
  ["page scripting in the command layer", '\nfn bypass() { send("Runtime.evaluate"); }', /不得绕开采集连接执行页面脚本或输入命令/],
  ["self-installed document scripts", '\nfn bypass() { send("Page.addScriptToEvaluateOnNewDocument"); }', /不得绕开采集连接执行页面脚本或输入命令|不得自带 guard 模板/],
  ["a second guard script source", '\nfn peek(other: ManagedWatch) { let stolen = other.login_guard_script; }', /只能通过 managed_cdp::logout_guard_script/],
]) {
  test(`command layer rejects ${name}`, () => {
    fails(runChecker({ [commandsPath]: managedSources[commandsPath] + extra }, { managed: true }), expected);
  });
}

for (const method of ["Runtime.evaluate", "Runtime.callFunctionOn", "Input.dispatchKeyEvent", "Network.getCookies", "Storage.getCookies", "Fetch.enable", "Page.navigate"]) {
  test(`collector cannot acquire ${method}`, () => {
    fails(runChecker({
      [cdpPath]: managedSources[cdpPath].replace(
        'fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {',
        `fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> { send("${method}");`,
      ),
    }, { managed: true }), /采集通道拿到了只读采集用不着的能力/);
  });
}

for (const method of ["Runtime.enable", "Runtime.addBinding", "Runtime.bindingCalled"]) {
  test(`address-only collection rejects ${method}`, () => {
    fails(runChecker(change(cdpPath,
      'self.command(Some(session_id), "Page.enable", json!({}))',
      `self.command(Some(session_id), "Page.enable", json!({})), self.command(Some(session_id), "${method}", json!({}))`,
    ), { managed: true }), /只读采集用不着的能力/);
  });
}

test("collector I/O helper cannot bypass the read-only capability boundary", () => {
  const helper = '\nasync fn collect_events() { send("Runtime.enable"); }\n';
  fails(runChecker({ [cdpPath]: managedSources[cdpPath] + helper }, { managed: true }),
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
