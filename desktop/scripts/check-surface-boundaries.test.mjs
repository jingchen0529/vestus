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
  // 单连接模型：采集连接暂停新 target，装完采集脚本与固定 guard 后放行。
  [cdpPath]: `
struct ManagedWatch { login_guard_script: String }
const COLLECTOR_SCRIPT: &str = "collector";
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
        let mut commands = vec![
            self.command(Some(session_id), "Page.enable", json!({})),
            self.command(Some(session_id), "Runtime.enable", json!({})),
            self.command(Some(session_id), "Runtime.addBinding", json!({"name": BINDING_NAME})),
            self.command(Some(session_id), "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": COLLECTOR_SCRIPT})),
        ];
        if let Some(managed) = &self.managed {
            commands.push(self.command(Some(session_id), "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": managed.login_guard_script, "runImmediately": false})));
        }
        commands.push(self.command(Some(session_id), "Runtime.runIfWaitingForDebugger", json!({})));
        commands
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
  ["dynamic install source", '"source": managed.login_guard_script', '"source": frontend.script', /只能来自固定常量或 policy|policy 生成的固定字段/],
  ["missing guard install", '"source": managed.login_guard_script', '"source": COLLECTOR_SCRIPT', /policy 生成的固定字段/],
  ["a third document script", 'commands.push(self.command(Some(session_id), "Runtime.runIfWaitingForDebugger"', 'commands.push(self.command(Some(session_id), "Page.addScriptToEvaluateOnNewDocument", json!({"source": extra})));\n        commands.push(self.command(Some(session_id), "Runtime.runIfWaitingForDebugger"', /只允许安装采集脚本与固定 guard/],
  ["install before Page.enable", '"Page.enable"', '"Page.enableLater"', /Page\.enable 之后/],
  ["no debugger wait", '"waitForDebuggerOnStart": true', '"waitForDebuggerOnStart": false', /必须暂停新 target/],
  ["self-contained guard script", 'const COLLECTOR_SCRIPT: &str = "collector";', 'const COLLECTOR_SCRIPT: &str = "collector";\nconst RAW: &str = include_str!("managed_cdp/login_guard.js");', /只能在 managed_cdp 的 policy 里生成/],
  ["collapsed failure signals", "pub enum ManagedSignal { Expired, ConnectionLost }", "pub enum ManagedSignal { Expired }", /必须区分凭据过期与防护连接断开/],
]) {
  test(`managed boundary rejects ${name}`, () => {
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

for (const path of [policyPath, guardPath]) {
  test(`partial managed fixture cannot omit ${path}`, () => {
    fails(runChecker({ [path]: null }, { managed: true }), /必须包含固定脚本与 policy/);
  });
}

test("compiled managed module cannot omit all guard files", () => {
  fails(runChecker({ "desktop/src-tauri/src/lib.rs": "mod managed_cdp;" }), /必须包含固定脚本与 policy/);
});
