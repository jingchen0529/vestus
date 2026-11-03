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
const watchPath = "desktop/src-tauri/src/managed_cdp/watch.rs";
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
#[path = "managed_cdp/watch.rs"]
mod watch;
`,
  [watchPath]: `
struct WatchState { script: String }
impl WatchState {
    fn new(policy: LogoutPolicy) -> Self {
        let script = policy.login_guard_script();
        Self { script }
    }
    fn opening_commands(&mut self) {
        self.command(CommandKind::AutoAttach, "Target.setAutoAttach", json!({
            "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true,
            "filter": [{"type": "tab"}, {"exclude": true}],
        }), None, None);
    }
    fn attach_child_pages(&mut self, tab_session: &str) {
        self.command(CommandKind::AutoAttach, "Target.setAutoAttach", json!({
            "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true,
            "filter": [{"type": "page"}, {"exclude": true}],
        }), Some(tab_session), None);
    }
    fn install(&mut self, session: &str) {
        self.page_command(session, CommandKind::Install, "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": self.script, "runImmediately": true}));
        self.page_command(session, CommandKind::Enable, "Page.enable", json!({}));
        self.page_command(session, CommandKind::FrameTree, "Page.getFrameTree", json!({}));
        self.page_command(session, CommandKind::Resume, "Runtime.runIfWaitingForDebugger", json!({}));
    }
}
async fn prepare(endpoint: &DevToolsEndpoint, policy: LogoutPolicy) {
    let watch = LogoutWatch { socket: connect(endpoint).await?, state: WatchState::new(policy) };
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
  [cdpPath]: `
struct Collector { managed_guard: bool }
pub async fn collect(managed_guard: bool) {
    let collector = Collector { managed_guard };
}
impl Collector {
    fn opening_commands(&mut self) {
        self.command(None, "Target.setAutoAttach",
            json!({"waitForDebuggerOnStart": !self.managed_guard}));
    }
    fn install(&mut self, session_id: &str) {
        if !self.managed_guard {
            commands.push(self.command(Some(session_id), "Runtime.runIfWaitingForDebugger", json!({})));
        }
    }
    fn resume_and_detach(&mut self, session_id: &str) {
        if !self.managed_guard {
            commands.push(self.command(Some(session_id), "Runtime.runIfWaitingForDebugger", json!({})));
        }
        commands.push(self.command(Some(session_id), "Target.detachFromTarget", json!({})));
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
  test(`fixed managed guard and separate collector pass with ${JSON.stringify(eol)} line endings`, () => {
    passes(runChecker({}, { managed: true, eol }));
  });
}

test("guard accepts policy URL checks, style writes and harmless formatting changes", () => {
  passes(runChecker({
    [policyPath]: managedSources[policyPath]
      .replace('"origin": self.login_route.origin().ascii_serialization(),\n                "path": self.login_route.path(),',
        '"path": self.login_route.path(), /* fixed route */\n                "origin": self.login_route.origin().ascii_serialization(),'),
    [watchPath]: managedSources[watchPath]
      .replace('"source": self.script, "runImmediately": true', '"runImmediately" : true, "source" : self.script.clone(),'),
    [guardPath]: managedSources[guardPath] + "\n// Never read document.cookie or call fetch().\n",
  }, { managed: true }));
});

test("tab-to-page attachment keeps both filters explicit", () => {
  passes(runChecker({
    [watchPath]: managedSources[watchPath]
      .replace('{"type": "tab"}', '{"exclude": false, "type": "tab"}')
      .replace('{"type": "page"}', '{"type": "page", "exclude": false}'),
  }, { managed: true }));
});

test("watch does not regain unnecessary Runtime.enable", () => {
  fails(runChecker({
    [watchPath]: managedSources[watchPath] + '\nfn enable_runtime() { send("Runtime.enable"); }',
  }, { managed: true }), /托管 watch 超出固定防护 CDP 能力/);
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
    [watchPath]: localTest + managedSources[watchPath],
    [cdpPath]: localTest + managedSources[cdpPath],
    [commandsPath]: localTest,
  }, { managed: true, eol: "\r\n" }));
  fails(runChecker({
    [watchPath]: localTest + managedSources[watchPath] + '\nfn bypass() { send("Runtime.evaluate"); }',
  }, { managed: true }), /托管 watch 超出固定防护 CDP 能力/);
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

for (const [name, path, from, to, expected] of [
  ["frontend policy source", policyPath, 'include_str!("managed_cdp/login_guard.js")', "frontend_script", /只能编译固定脚本/],
  ["extra template data", policyPath, '"path": self.login_route.path(),', '"path": self.login_route.path(), "source": frontend_script,', /只能编译固定脚本/],
  ["frontend route", policyPath, 'Url::parse("https://agent.oceanengine.com/login")', "Url::parse(target_url)", /固定方舟 policy/],
  ["dynamic install source", watchPath, '"source": self.script', '"source": frontend.script', /不能使用前端动态 source/],
  ["external constructor script", watchPath, "fn new(policy: LogoutPolicy)", "fn new(policy: LogoutPolicy, script: String)", /不能从前端传入/],
  ["script append", watchPath, "fn opening_commands(&mut self) {", 'fn opening_commands(&mut self) { self.script.push_str(&frontend_script);', /不得改写固定脚本/],
  ["non-immediate injection", watchPath, '"runImmediately": true', '"runImmediately": false', /只能立即安装/],
  ["worker pause", watchPath, '"type": "page"', '"type": "worker"', /只能暂停显式 page\/tab target/],
  ["unfiltered targets", watchPath, ', {"exclude": true}', "", /只能暂停显式 page\/tab target/],
  ["no debugger wait", watchPath, '"waitForDebuggerOnStart": true', '"waitForDebuggerOnStart": false', /只能暂停显式 page\/tab target/],
  ["shared collector connection", watchPath, "connect(endpoint)", "crate::cdp::connect(endpoint)", /自己的 CDP 连接/],
  ["collector pausing managed targets", cdpPath, '"waitForDebuggerOnStart": !self.managed_guard', '"waitForDebuggerOnStart": true', /采集连接不得暂停目标/],
  ["collector resuming managed targets", cdpPath, "if !self.managed_guard {", "if self.managed_guard {", /只能在 !self.managed_guard 分支恢复目标/],
]) {
  test(`managed boundary rejects ${name}`, () => {
    fails(runChecker(change(path, from, to), { managed: true }), expected);
  });
}

for (const method of ["Runtime.evaluate", "Runtime.callFunctionOn", "Input.dispatchKeyEvent", "Network.getCookies", "Storage.getCookies", "Fetch.enable", "Page.navigate"]) {
  test(`watch cannot acquire ${method}`, () => {
    fails(runChecker({
      [watchPath]: managedSources[watchPath] + `\nfn bypass() { send("${method}"); }`,
    }, { managed: true }), /托管 watch 超出固定防护 CDP 能力/);
  });
}

for (const path of [policyPath, commandsPath]) {
  test(`page scripting cannot move into ${path}`, () => {
    fails(runChecker({
      [path]: (managedSources[path] || "") + '\nfn bypass() { send("Runtime.evaluate"); }',
    }, { managed: true }), /不得绕开独立 watch/);
  });
}

test("collector helpers cannot regain arbitrary page execution", () => {
  fails(runChecker(change(cdpPath, "fn install(&mut self, session_id: &str) {",
    'fn install(&mut self, session_id: &str) { send("Runtime.evaluate");'), { managed: true }), /采集通道拿到了只读采集用不着的能力/);
});

test("an unguarded collector resume outside the usual helper is also rejected", () => {
  fails(runChecker({
    [cdpPath]: managedSources[cdpPath] + '\nfn bypass() { send("Runtime.runIfWaitingForDebugger"); }',
  }, { managed: true }), /只能在 !self.managed_guard 分支恢复目标/);
});

for (const path of [policyPath, watchPath, guardPath]) {
  test(`partial managed fixture cannot omit ${path}`, () => {
    fails(runChecker({ [path]: null }, { managed: true }), /必须包含固定脚本、policy 和独立 watch 模块/);
  });
}

test("compiled managed module cannot omit all guard files", () => {
  fails(runChecker({ "desktop/src-tauri/src/lib.rs": "mod managed_cdp;" }), /必须包含固定脚本、policy 和独立 watch 模块/);
});
