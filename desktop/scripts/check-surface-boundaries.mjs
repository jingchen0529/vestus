import { existsSync, readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// Small lexical helpers, not a Rust/JS parser. Keep quoted strings intact when
// checking capabilities, but mask them when locating braces. In particular, a
// local #[cfg(test)] item must not hide production code that follows it.
function maskSource(source, { strings = false, javascript = false } = {}) {
  const literals = javascript
    ? /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g
    : /\br(#+)?"[\s\S]*?"\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(literals, (token) =>
    strings || token.startsWith("//") || token.startsWith("/*")
      ? token.replace(/[^\n]/g, " ")
      : token,
  );
}

function blockEnd(masked, start) {
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    if (masked[index] === "}" && --depth === 0) return index + 1;
  }
  throw new Error("边界检查无法定位代码块结尾");
}

function rustProduction(source) {
  source = source.replace(/\r\n?/g, "\n");
  const masked = maskSource(source, { strings: true });
  const chunks = [];
  let keptFrom = 0;
  for (const match of masked.matchAll(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g)) {
    if (match.index < keptFrom) continue;
    let nesting = 0;
    let end = match.index + match[0].length;
    for (; end < masked.length; end += 1) {
      const char = masked[end];
      if (char === "(" || char === "[") nesting += 1;
      if (char === ")" || char === "]") nesting -= 1;
      if (nesting !== 0) continue;
      if (char === ";") { end += 1; break; }
      if (char === "{") { end = blockEnd(masked, end); break; }
    }
    chunks.push(source.slice(keptFrom, match.index));
    chunks.push(source.slice(match.index, end).replace(/[^\n]/g, " "));
    keptFrom = end;
  }
  chunks.push(source.slice(keptFrom));
  return maskSource(chunks.join(""));
}

function rustBody(source, signature) {
  const masked = maskSource(source, { strings: true });
  const match = masked.match(signature);
  if (!match) return "";
  const start = masked.indexOf("{", match.index + match[0].length);
  if (start < 0) return "";
  return source.slice(start + 1, blockEnd(masked, start) - 1);
}

// Ignore formatting, not whitespace inside literals. Used only for the tiny
// fixed-template expression and CDP parameter values, not whole-file snapshots.
const compact = (source) => {
  const tokens = source.match(/"(?:\\.|[^"\\])*"|\S/g) || [];
  // Rustfmt may add trailing commas when it wraps a fixed expression. Ignore
  // those delimiters only, never commas or whitespace inside quoted values.
  return tokens.filter((token, index) =>
    token !== "," || !["}", ")", "]"].includes(tokens[index + 1]),
  ).join("");
};

// Inspect individual command/branch boundaries rather than snapshotting a
// function or counting all ACK variants in the collector. This stays lexical:
// runtime state-machine behavior is covered by Rust/stream tests, not proven here.
function rustCalls(source, name) {
  const masked = maskSource(source, { strings: true });
  const calls = [];
  for (const match of masked.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
    const start = masked.indexOf("(", match.index);
    let depth = 1;
    let end = start + 1;
    for (; end < masked.length && depth; end += 1) {
      if (masked[end] === "(") depth += 1;
      if (masked[end] === ")") depth -= 1;
    }
    assert(depth === 0, `边界检查无法定位 ${name} 调用结尾`);
    calls.push({ start: match.index, end, args: source.slice(start + 1, end - 1) });
  }
  return calls;
}

const occurrences = (source, pattern) => (source.match(pattern) || []).length;
const commandsIn = (source) => rustCalls(source, "command").map((call) => ({
  ...call,
  method: call.args.match(/"([A-Za-z]+\.[A-Za-z]+)"/)?.[1],
}));

function ifBranches(source, condition) {
  const masked = maskSource(source, { strings: true });
  const match = masked.match(condition);
  if (!match) return { yes: "", no: "" };
  const start = masked.indexOf("{", match.index + match[0].length);
  const end = blockEnd(masked, start);
  const otherwise = masked.slice(end).match(/^\s*else\s*\{/);
  const elseStart = otherwise ? end + otherwise[0].lastIndexOf("{") : -1;
  return {
    yes: source.slice(start + 1, end - 1),
    no: elseStart < 0 ? "" : source.slice(elseStart + 1, blockEnd(masked, elseStart) - 1),
  };
}

const webAdmin = read("../web/admin.html");
assert(webAdmin.includes("/api/admin/auth/login"), "Web 管理后台缺少管理员登录接口");
assert(!webAdmin.includes("/api/user/auth/login"), "Web 管理后台不得包含桌面用户登录接口");

const rustAuth = read("src-tauri/src/auth.rs");
for (const path of [
  "/api/user/auth/login",
  "/api/user/auth/me",
  "/api/user/auth/logout",
]) {
  assert(rustAuth.includes(path), `Rust 桌面认证缺少 ${path}`);
}
assert(!rustAuth.includes("/api/admin/auth/"), "Rust 桌面认证不得调用管理员认证接口");
const desktopUserDto = rustAuth.slice(
  rustAuth.indexOf("pub struct DesktopUser"),
  rustAuth.indexOf("impl DesktopUser")
);
for (const forbidden of [
  "phone",
  "max_sessions",
  "failed_login_count",
  "locked_until",
  "created_by",
  "remark",
  "created_at",
  "updated_at",
  "last_login_at",
]) {
  assert(!desktopUserDto.includes(forbidden), `桌面用户 IPC 仍暴露管理字段：${forbidden}`);
}

const rustCommands = read("src-tauri/src/lib.rs");
assert(!rustCommands.includes("commands::close_browser"), "Rust 仍注册多余的关闭浏览器 IPC");
assert(!rustCommands.includes("commands::stop_proxy"), "Rust 仍注册多余的停止代理 IPC");

// The command layer is split by domain under src-tauri/src/commands/; the
// scan must cover the root file plus every submodule, otherwise moving a
// dangerous capability into a submodule would silently bypass these checks.
// Missing directories are fine so the small synthetic fixtures still work.
const commandDir = "src-tauri/src/commands";
const commandFiles = [
  "src-tauri/src/commands.rs",
  ...(existsSync(new URL(commandDir, root))
    ? readdirSync(new URL(commandDir, root))
        // tests.rs is test-only code; rustProduction-style checks do not apply.
        .filter((name) => name.endsWith(".rs") && name !== "tests.rs")
        .sort()
        .map((name) => `${commandDir}/${name}`)
    : []),
];
const rustCommandSource = commandFiles
  .filter((path) => existsSync(new URL(path, root)))
  .map((path) => read(path))
  .join("\n");

// Repeated platform-button clicks may only activate the existing page.  The
// command layer must not regain either of the old new-target/new-window
// fallbacks; the browser manager helpers remain available only for legacy
// lower-level tests and are not reachable from the IPC command.
assert(
  !rustCommandSource.includes("Target.createTarget"),
  "平台按钮仍可创建第二个页面目标",
);
assert(
  !rustCommandSource.includes(".hand_off("),
  "平台按钮仍可转交到新窗口",
);

// 页面自动化已移除：不得替用户操作浏览器。
assert(!rustCommands.includes("mod page;"), "页面自动化模块又参与编译了：mod page;");
assert(
  !rustCommands.includes("commands::run_page_script"),
  "Rust 仍注册页面自动化 IPC：run_page_script"
);

// 地址采集不注入页面脚本，也不订阅 Runtime 事件；托管固定 guard 是唯一例外。
const rustCdp = rustProduction(read("src-tauri/src/cdp.rs"));
// 检查采集入口、实际 IO helper 和状态机；一次性生命周期控制连接不在其中。
const collectSurface =
  rustBody(rustCdp, /\bpub\s+async\s+fn\s+collect\s*\(/) +
  rustBody(rustCdp, /\basync\s+fn\s+collect_events\s*\(/) +
  rustBody(rustCdp, /\bimpl\s+Collector\b/);
// 带前导引号匹配 CDP 方法名，才不会把 Page.navigatedWithinDocument 这类事件名
// 当成 Page.navigate 命令。
for (const method of [
  '"Page.navigate"',
  '"Page.goBack',
  '"Page.goForward',
  '"Page.reload',
  '"Page.captureScreenshot',
  '"Page.printToPDF',
  '"Runtime.enable',
  '"Runtime.addBinding',
  '"Runtime.bindingCalled',
  '"Runtime.evaluate',
  '"Runtime.callFunctionOn',
  '"Target.createTarget',
  '"Input.',
  '"DOM.',
  '"Storage.',
  '"Emulation.',
  '"Fetch.',
  '"Network.enable',
  '"Network.getCookies',
  '"Network.setCookie',
]) {
  assert(!collectSurface.includes(method), `采集通道拿到了只读采集用不着的能力：${method}`);
}

// The fixed login guard is an intentionally narrow exception to page writes.
// Old/minimal checker fixtures can omit managed sessions altogether, but a
// compiled managed module (or any of its guard files) requires the whole unit.
//
// 2026-11-04 起托管防护回到**单连接模型**：采集连接本身就是唯一的 CDP 客户端，
// 新 target 暂停到地址订阅与托管固定 guard 就位后再放行。独立的第二条防护连接
// 会让 window.open 弹窗停在 about:blank，已删除；这里只校验单连接上的边界。
const managedPaths = [
  "src-tauri/src/managed_cdp.rs",
  "src-tauri/src/managed_cdp/login_guard.js",
];
const managedFilesPresent = managedPaths.map((path) => existsSync(new URL(path, root)));
if (managedFilesPresent.some(Boolean) || /\bmod\s+managed_cdp\s*;/.test(rustProduction(rustCommands))) {
  assert(managedFilesPresent.every(Boolean), "托管防护必须包含固定脚本与 policy");
  const managed = rustProduction(read(managedPaths[0]));
  const guard = maskSource(read(managedPaths[1]), { javascript: true });

  assert(
    /\blogin_route\s*:\s*Url\s*::\s*parse\s*\(\s*"https:\/\/agent\.oceanengine\.com\/login"\s*\)/.test(
      rustBody(managed, /\bfn\s+for_platform\s*\(/),
    ),
    "托管登录路由必须来自固定方舟 policy，其他产品须另行适配",
  );

  // Check the small trust-boundary expression, not the entire implementation.
  // Only JSON origin/path from policy may be substituted; no frontend or
  // bootstrap script, additional replacement, or appended source is allowed.
  const templateBody = rustBody(managed, /\bfn\s+login_guard_script\s*\(/)
    .trim().replace(/^return\s+/, "").replace(/;$/, "");
  const template = compact(templateBody).match(
    /^include_str!\("managed_cdp\/login_guard\.js"\)\.replace\("__VESTUS_LOGIN_ROUTE__",&json!\(\{([\s\S]*)\}\)\.to_string\(\),?\)$/,
  );
  const routeFields = template?.[1].split(",").filter(Boolean) || [];
  const allowedRouteFields = new Set([
    '"origin":self.login_route.origin().ascii_serialization()',
    '"path":self.login_route.path()',
  ]);
  assert(
    routeFields.length === 2 && new Set(routeFields).size === 2 &&
      routeFields.every((field) => allowedRouteFields.has(field)),
    "托管 guard 只能编译固定脚本并替换 policy 的 origin/path，不能接收动态脚本",
  );
  const placeholders = guard.match(/__[A-Z][A-Z0-9_]*__/g) || [];
  assert(
    placeholders.length === 1 && placeholders[0] === "__VESTUS_LOGIN_ROUTE__" &&
      /\bconst\s+route\s*=\s*__VESTUS_LOGIN_ROUTE__\s*;/.test(guard),
    "托管 guard 模板只能包含一个 origin/path 路由占位符",
  );

  // URL username/password emptiness checks are allowed. DOM field reads and
  // storage/network/dynamic-code capabilities are not; local style restoration
  // and Object.defineProperty(..., { value: true }) are not field-value reads.
  for (const [pattern, capability] of [
    [/\b(?:cookie|cookieStore|localStorage|sessionStorage|indexedDB|credentials)\b/, "Cookie/凭据或浏览器存储"],
    [/(?:\.\s*(?:value|checked|files|textContent|innerText|innerHTML|outerHTML)\b|\[\s*['"](?:value|checked|files|textContent|innerText|innerHTML|outerHTML)['"]\s*\]|\b(?:FormData|FileReader|querySelector|querySelectorAll|getElementById|getElementsByName|getAttribute)\s*\()/, "DOM 字段或表单值"],
    [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|WebTransport|RTCPeerConnection|Worker|SharedWorker|importScripts|Image|createElement|createElementNS)\b/, "网络或外部资源请求"],
    [/\b(?:eval|Function|AsyncFunction|GeneratorFunction|execScript|setTimeout|setInterval)\s*\(|\bimport\s*\(/, "动态脚本执行"],
  ]) {
    assert(!pattern.test(guard), `托管固定 guard 不得读取或执行：${capability}`);
  }

  // 扩展防护模型（2026-11-21）：登录页交互锁由随包 MV3 扩展在 document_start 注入。
  // 采集连接不再暂停任何 target——实测 Chrome/157 上 noopener 弹窗的防护安装回执
  // 要等 resume 才返回，暂停会形成回执循环。CDP 只负责采集订阅、就绪闩与退出监控。
  const openingCommands = rustBody(rustCdp, /\bfn\s+opening_commands\s*\(/);
  assert(
    /"autoAttach"\s*:\s*true\b/.test(openingCommands) &&
      /letwait_for_debugger=self\.managed\.is_none\(\);/.test(compact(openingCommands)) &&
      /"waitForDebuggerOnStart"\s*:\s*wait_for_debugger/.test(openingCommands) &&
      /"flatten"\s*:\s*true\b/.test(openingCommands),
    "托管必须关闭 debugger 暂停（waitForDebuggerOnStart=managed.is_none()），普通采集保持暂停+立即放行",
  );

  const installBody = rustBody(rustCdp, /\bfn\s+install\s*\(/);
  const installCompact = compact(installBody);
  const documentScripts = occurrences(collectSurface, /"Page\.addScriptToEvaluateOnNewDocument"/g);
  assert(
    documentScripts === 1,
    "地址采集只允许安装托管固定 guard 一个文档脚本（初始页兜底层）",
  );
  // The local source must remain an unchanged clone of the policy-produced field,
  // injected only into the initial page as a second layer behind the extension.
  assert(
    /letmanaged=self\.managed\.is_some\(\);/.test(installCompact) &&
      /ifletSome\(state\)=self\.managed\.as_ref\(\)\{ifinitial\{commands\.push\(self\.command\(/.test(installCompact) &&
      /"source":state\.login_guard_script\.clone\(\),"runImmediately":true/.test(installCompact) &&
      (installBody.match(/"source"\s*:/g) || []).length === 1,
    "托管 guard 只能来自 policy 生成的固定字段，且只注入初始页（主防线是随包扩展）",
  );
  const installCommands = commandsIn(installBody);
  assert(
    compact(installCommands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")?.args ?? "")
      .startsWith('Some(session_id),"Page.addScriptToEvaluateOnNewDocument",'),
    "固定 guard 必须绑定当前 session 的安装请求，不能跨页安装",
  );
  // 初始页：guard → enable → tree → lifecycle，各登记 Install ACK；
  // 后续页：enable → tree → lifecycle，各登记 Monitor ACK，且不得出现文档脚本。
  const addScriptAt = installBody.indexOf('"Page.addScriptToEvaluateOnNewDocument"');
  const enableAt = installBody.indexOf('"Page.enable"');
  const treeAt = installBody.indexOf('"Page.getFrameTree"');
  const lifecycleAt = installBody.indexOf('"Page.setLifecycleEventsEnabled"');
  assert(
    addScriptAt >= 0 && enableAt > addScriptAt && treeAt > enableAt && lifecycleAt > treeAt,
    "初始固定 guard 必须在 Page.enable 之前安装，frame tree 与 lifecycle 订阅随后执行",
  );
  assert(
    (installCompact.match(/tracked\(self,GuardRequest::Install\);/g) || []).length === 1 &&
      (installCompact.match(/tracked\(self,ifinitial\{GuardRequest::Install\}else\{GuardRequest::Monitor\}\);/g) || []).length === 4 &&
      (installCompact.match(/self\.frame_tree_requests\s*\.\s*insert\s*\(\s*self\.next_id,\s*session_id\.to_string\(\)\s*\)/g) || []).length === 1,
    "初始页登记五条 Install ACK（guard 字面量 + enable/tree/lifecycle/resume 走初始分支），后续页登记四条 Monitor ACK，tree 每页恰好一条",
  );
  assert(
    /ifletSome\(page\)=self\.sessions\.get\(session_id\)\.is_some_and\(\|page\|page\.initial\);/.test(installCompact) ||
      /letinitial=self\.sessions\.get\(session_id\)\.is_some_and\(\|page\|page\.initial\);/.test(installCompact),
    "初始/后续判定必须来自 page.initial，不能按 URL 或首次附着猜",
  );
  const ordinaryResume = ifBranches(installBody.slice(treeAt), /\bif\s+managed\s*\b/).no;
  assert(
    compact(ordinaryResume) === "commands.push(self.resume_page(session_id));" &&
      occurrences(installBody, /\.resume_page\s*\(/g) === 2,
    "resume 必须在安装批次内无条件发送（flatten autoAttach 会挂起新 target，与 waitFor 无关）；普通采集保持原路径",
  );
  assert(
    /"Page\.setLifecycleEventsEnabled",json!\(\{"enabled":true\}\)/.test(installCompact),
    "托管采集必须订阅 lifecycle（登录页稳定停留判定的输入）",
  );
  assert(
    !/GuardRequest::Resume\(|GuardRequest::Guard\(|PagePhase|\.resumed\b|Resume\(String\)/.test(rustCdp),
    "暂停状态机不得回归：实测 flatten autoAttach 下 noopener 弹窗的防护回执依赖 resume，构成回执循环",
  );

  const ackBody = rustBody(rustCdp, /\bfn\s+acknowledge_guard\s*\(/);
  const ackCompact = compact(ackBody);
  const resumeBody = rustBody(rustCdp, /\bfn\s+resume_page\s*\(/);
  const handleBody = rustBody(rustCdp, /\bfn\s+handle\s*\(/);
  const sessionCheckAt = ackCompact.indexOf('ifmessage.get("sessionId").and_then(Value::as_str)!=session{return;}');
  const removeAt = ackCompact.indexOf('self.guard_requests.remove(&id);');
  const acceptedAt = ackCompact.indexOf('letaccepted=message.get("error").is_none()&&message.get("result").is_some_and(Value::is_object)');
  const rejection = ifBranches(ackBody, /\bif\s*!\s*accepted\s*/).yes;
  const rejectAt = ackBody.indexOf(rejection);
  assert(
    /letSome\(request\)=self\.guard_requests\.get\(&id\)\.cloned\(\)else\{return;?\};/.test(ackCompact) &&
      /GuardRequest::Install\(session\)\|GuardRequest::Monitor\(session\)=>\{?Some\(session\.as_str\(\)\)\}?/.test(ackCompact) &&
      sessionCheckAt >= 0 && acceptedAt > sessionCheckAt && removeAt > acceptedAt &&
      rejectAt > ackBody.indexOf("let accepted") &&
      ackBody.indexOf(rejection) + rejection.length < ackBody.indexOf("self.guard_requests.remove") &&
      /self\.fail_page\(session,reason,out\);/.test(compact(rejection)) &&
      /self\.acknowledge_guard\(id,&message,&mutout\);/.test(compact(handleBody)),
    "托管 ACK handler 必须先核对请求 ID、session、无 error 的对象 result；拒绝按请求类别走局部或全局失败",
  );
  assert(
    /GuardRequest::Install\(_\)=>"guard_install_failed"/.test(ackCompact) &&
      /GuardRequest::Monitor\(_\)=>"monitor_install_failed"/.test(ackCompact) &&
      /GuardRequest::AutoAttach=>\{out\.guard_failed=true;return;\}/.test(ackCompact),
    "ACK 拒绝必须按请求类别分类：初始防护失败全局关闭，订阅失败只关所属页",
  );
  assert(
    /!self\.frame_tree_requests\.contains_key\(&id\)\|\|message\.pointer\("\/result\/frameTree\/frame\/id"\)\.and_then\(Value::as_str\)\.is_some_and\(\|id\|!id\.is_empty\(\)\)/.test(ackCompact),
    "frame tree ACK 必须验证非空主 frame ID，不能只接受任意对象 result",
  );
  const dispatch = ackBody.slice(ackBody.indexOf("self.guard_requests.remove(&id);"));
  const arm = (variant) => rustBody(dispatch, new RegExp(`\\bGuardRequest::${variant}\\(session\\)\\s*=>`));
  const initialArm = compact(arm("Install"));
  const monitorArm = compact(arm("Monitor"));
  assert(
    /letpending=self\.guard_requests\.values\(\)\.any\(\|request\|matches!\(request,GuardRequest::Install\(other\)ifother==&session\)\);if!pending\{ifletSome\(page\)=self\.sessions\.get_mut\(&session\)\{page\.deadline=None;ifletSome\(state\)=self\.managed\.as_ref\(\)\{state\.guard_installed\.mark_for\(&page\.target_id\);\}out\.guard_installed=true;\}\}/.test(initialArm) &&
      monitorArm === "self.finish_popup_setup(&session);" &&
      occurrences(ackBody, /\.resume_page\s*\(/g) === 0 &&
      occurrences(ackBody, /\.enable_popup\s*\(/g) === 0,
    "初始页全部安装回执完成即置就绪闩（扩展模式无暂停、无 resume）；后续页只由 Monitor ACK 收尾",
  );
  // Resume is a tightly scoped debugger-release exception, not general Runtime:
  // ordinary collection and worker/duplicate release, never managed pages.
  const collectorBody = rustBody(rustCdp, /\bimpl\s+Collector\b/);
  const resumeDetach = rustBody(rustCdp, /\bfn\s+resume_and_detach\s*\(/);
  const withoutRelease = collectorBody.replace(resumeBody, "").replace(resumeDetach, "");
  assert(
    !withoutRelease.includes('"Runtime.runIfWaitingForDebugger"') &&
      occurrences(collectorBody, /\.resume_page\s*\(/g) ===
        occurrences(installBody + ackBody + resumeDetach, /\.resume_page\s*\(/g) &&
      resumeBody.includes('"Runtime.runIfWaitingForDebugger"') &&
      !/GuardRequest::Resume/.test(resumeBody) &&
      !/page\.resumed|\.phase\s*=/.test(resumeBody),
    "resume 回执只参与初始就绪闩与后续页预算，绝不能变成防护 ACK 门禁；worker/重复 session 释放保留",
  );
  const attached = rustBody(rustCdp, /\bfn\s+on_attached\s*\(/);
  assert(
    /initial:self\.managed\.as_ref\(\)\.is_some_and\(\|state\|state\.guard_installed\.is_initial_target\(target_id\)\)/.test(compact(attached)),
    "初始 target 必须由就绪闩的 target 标识判定，追加页面不得满足首次导航就绪",
  );
  const duplicate = rustBody(attached, /\bif\s+self\s*\.\s*is_installed_target\s*\(target_id\)/);
  const duplicateBranches = ifBranches(duplicate, /\bif\s+self\s*\.\s*managed\s*\.\s*is_some\s*\(\s*\)\s*/);
  assert(
    commandsIn(duplicateBranches.yes).map((command) => command.method).join(",") === "Target.detachFromTarget" &&
      !/resume/.test(duplicateBranches.yes) &&
      /out\.commands\.extend\(self\.resume_and_detach\(&session_id\)\);/.test(compact(duplicateBranches.no)) &&
      compact(ifBranches(attached, /\bif\s+self\s*\.\s*sessions\s*\.\s*contains_key\s*\(&session_id\)/).yes) === "return;",
    "重复追加 attachment：托管直接断开（不暂停无须放行），普通保持先放行再断开",
  );

  const events = rustBody(rustCdp, /\basync\s+fn\s+collect_events\s*\(/);
  assert(
    occurrences(events, /\bconnect\s*\(/g) === 1 &&
      !/\b(?:connect|connect_async|control_command|tokio\s*::\s*spawn)\s*\(/.test(collectorBody) &&
      !/\b(?:connect|connect_async|control_command)\s*\(/.test(rustBody(rustCdp, /\bpub\s+async\s+fn\s+collect\s*\(/)),
    "托管防护与地址采集必须共用唯一长连接，不得新增第二个防护客户端",
  );

  const deadline = compact(rustBody(rustCdp, /\bfn\s+setup_deadline\s*\(/));
  const expiry = compact(rustBody(rustCdp, /\bfn\s+expire_setup\s*\(/));
  const failure = compact(rustBody(rustCdp, /\bfn\s+fail_page\s*\(/));
  const finish = compact(rustBody(rustCdp, /\bfn\s+finish_popup_setup\s*\(/));
  assert(
    /deadline:self\.managed\.as_ref\(\)\.map\(\|_\|\{tokio::time::Instant::now\(\)\+crate::managed_cdp::GUARD_INSTALL_TIMEOUT\}\)/.test(compact(attached)) &&
      /self\.sessions\.values\(\)\.filter_map\(\|page\|page\.deadline\)/.test(deadline) &&
      /self\.closing_targets\.values\(\)/.test(deadline) && /closing\.deadline/.test(deadline) && deadline.endsWith(".min()") &&
      /page\.deadline\.is_some_and\(\|deadline\|deadline<=now\)/.test(expiry) &&
      /self\.fail_page\(&session,reason,&mutout\);/.test(expiry) &&
      /letreason=ifpage\.initial\{"guard_install_timeout"\}else\{"monitor_install_timeout"\};/.test(expiry) &&
      !/page_resume_timeout|page_resume_failed|GuardRequest::Guard|GuardRequest::Resume|PagePhase|\.resumed/.test(rustCdp) &&
      !/\bfn\s+enable_popup\s*\(/.test(rustCdp) &&
      /closing\.deadline<=now/.test(expiry) && /out\.guard_failed=true;returnout;/.test(expiry) &&
      /collector\.expire_setup\(\)/.test(events) && /collector\.setup_deadline\(\)/.test(events) &&
      /sleep_until\(deadline\)\.await/.test(events) &&
      /ifletSome\(deadline\)=setup_deadline\{tokio::time::sleep_until\(deadline\)\.await;/.test(compact(events)) &&
      /matches!\(request,GuardRequest::Monitor\(session\)ifsession==session_id\)/.test(finish) &&
      /if!pending\{ifletSome\(page\)=self\.sessions\.get_mut\(session_id\)\{page\.deadline=None;/.test(finish) &&
      /self\.frame_tree_requests\s*\.\s*retain\(\|_,session\|session!=session_id\)/.test(finish),
    "每个托管页面及关闭验证必须有有界 deadline，缺失 ACK 必须定时处理；Monitor 集合完成后即清除追加页面 deadline",
  );
  assert(
    /ifpage\.initial\{out\.guard_failed=true;return;\}/.test(failure) &&
      /lettarget=page\.target_id\.clone\(\);/.test(failure) &&
      /filter\(\|\(_,page\)\|page\.target_id==target\)/.test(failure) &&
      /self\.forget_session\(&session\);/.test(failure) &&
      /deadline:tokio::time::Instant::now\(\)\+crate::managed_cdp::GUARD_INSTALL_TIMEOUT/.test(failure) &&
      /self\.command\(None,"Target.closeTarget",json!\(\{"targetId":target\}\)\)/.test(failure) &&
      /self\.close_requests\.insert\(self\.next_id,CloseRequest::Close\(target\)\);/.test(failure),
    "初始失败必须 fail closed，追加失败只能关闭所属 target 并清理同 target session，关闭验证保持有界",
  );
  const closeBody = rustBody(rustCdp, /\bfn\s+acknowledge_close\s*\(/);
  const closeCompact = compact(closeBody);
  const closeArm = compact(rustBody(closeBody, /\bCloseRequest::Close\(target\)\s*=>/));
  const verifyPattern = /\bCloseRequest::Verify\(target\)(?:\s*\|\s*CloseRequest::Detached\(target\))?\s*=>/;
  const verifyBody = rustBody(closeBody, verifyPattern);
  const verifyArm = compact(verifyBody);
  assert(
    /letSome\(request\)=self\.close_requests\.get\(&id\)\.cloned\(\)else\{return;?\};/.test(closeCompact) &&
      /ifmessage\.get\("sessionId"\)\.is_some\(\)\{return;\}/.test(closeCompact) &&
      closeCompact.indexOf('ifmessage.get("sessionId")') < closeCompact.indexOf("self.close_requests.remove(&id)") &&
      /self\.command\(None,"Target.getTargets",json!\(\{\}\)\)/.test(closeArm) &&
      /self\.close_requests\.insert\(self\.next_id,CloseRequest::Verify\(target\)\);/.test(closeArm) &&
      /message\.pointer\("\/result\/targetInfos"\)\.and_then\(Value::as_array\)\.filter\(\|targets\|(?:\{)?message\.get\("error"\)\.is_none\(\)&&targets\.iter\(\)\.all\(\|info\|\{info\.get\("targetId"\)\.and_then\(Value::as_str\)\.is_some_and\(\|id\|!id\.is_empty\(\)\)\}\)(?:\})?\)else\{out\.guard_failed=true;return;\}/.test(verifyArm) &&
      /info\.get\("targetId"\)\.and_then\(Value::as_str\)==Some\(&target\)/.test(verifyArm) &&
      /ifletSome\(closed\)=self\.closing_targets\.remove\(&target\)/.test(verifyArm) &&
      /ManagedSignal::PageClosed\{reason:closed\.reason\}/.test(verifyArm) &&
      occurrences(collectSurface, /ManagedSignal::PageClosed\s*\{/g) === 1 &&
      /self\.acknowledge_close\(id,&message,&mutout\);/.test(compact(handleBody)),
    "关闭验证必须核对请求 ID、无 session 的 browser ACK、有效 targetInfos 与所属 target 缺席，才发布 scoped PageClosed；detach 不是销毁证明",
  );
  const detachedBody = rustBody(rustCdp, /\bfn\s+on_detached\s*\(/);
  if (detachedBody || /CloseRequest::Detached\b/.test(closeBody)) {
    const detachedCompact = compact(detachedBody);
    assert(
      /self\.sessions\.get\(session_id\)\.map\(\|page\|\(page\.target_id\.clone\(\),page\.initial\)\)/.test(detachedCompact) &&
        /self\.closing_targets\.insert\(target\.clone\(\),ClosingTarget\{/.test(detachedCompact) &&
        /deadline:tokio::time::Instant::now\(\)\+crate::managed_cdp::GUARD_INSTALL_TIMEOUT/.test(detachedCompact) &&
        /initial,notify:false/.test(detachedCompact) &&
        /self\.command\(None,"Target.getTargets",json!\(\{\}\)\)/.test(detachedCompact) &&
        /self\.close_requests\.insert\(self\.next_id,CloseRequest::Detached\(target\)\);/.test(detachedCompact) &&
        /CloseRequest::Verify\(target\)\|CloseRequest::Detached\(target\)=>/.test(closeCompact) &&
        /letdetached=matches!\(&request,CloseRequest::Detached\(_\)\);/.test(closeCompact) &&
        /ifclosing\.initial\{out\.guard_failed=true;return;\}/.test(verifyArm) &&
        /closing\.notify=true;/.test(verifyArm) &&
        /self\.command\(None,"Target.closeTarget",json!\(\{"targetId":target\}\)\)/.test(verifyArm) &&
        /self\.closing_targets\.remove\(&target\)\.filter\(\|closed\|closed\.notify\)/.test(verifyArm) &&
        /self\.on_detached\(gone,&mutout\);/.test(compact(handleBody)),
      "canonical detach 必须隔离同 target、登记有界 Detached 缺席验证；存活初始页 fail closed，存活追加页 scoped close，用户关闭静默清理",
    );
  }
  assert(
    !/\.deadline\s*=|closing_targets\s*\.\s*insert\s*\(/.test(closeBody),
    "关闭验证不得续期 deadline 或重建 closing target，重试必须受原有期限约束",
  );
  if (/\bretry_at\b/.test(closeBody)) {
    assert(
      /closing\.retry_at/.test(deadline) &&
        /closing\.retry_at\.is_some_and\(\|deadline\|deadline<=now\)/.test(expiry) &&
        /self\.close_requests\.insert\(self\.next_id,CloseRequest::Verify\(target\)\);/.test(expiry) &&
        /self\.command\(None,"Target.getTargets",json!\(\{\}\)\)/.test(expiry),
      "关闭重试必须由有界 timer 唤醒并继续登记 scoped Verify 请求",
    );
  }
  const present = ifBranches(verifyBody, /\bif\s+targets\s*\.\s*iter\s*\(\s*\)\s*\.\s*any\s*\(/).yes;
  assert(
    present && /return;$/.test(compact(present)) &&
      !/PageClosed|closing_targets\s*\.\s*remove/.test(present),
    "关闭验证中 target 仍存在时必须退出或有界重试，不能误报 PageClosed",
  );
  assert(
    !/__VESTUS_LOGIN_ROUTE__|login_guard\.js|include_str!/.test(rustCdp),
    "固定 guard 只能在 managed_cdp 的 policy 里生成，采集通道不得自带脚本",
  );

  const managedSignal = rustBody(rustCdp, /\benum\s+ManagedSignal\b/);
  assert(
    /\bExpired\b/.test(managedSignal) && /\bConnectionLost\b/.test(managedSignal),
    "托管信号必须区分凭据过期与防护连接断开",
  );

  // 随包扩展生成：登录防护主防线。桌面端每次托管启动用 policy 生成 manifest 与
  // guard.js（同一模板），不支持的 fail closed；guard 模板仍只允许一份。
  const extensionBody = rustBody(managed, /\bfn\s+write_login_guard_extension\s*\(/);
  const extensionCompact = compact(extensionBody);
  assert(
    /\bfn\s+write_login_guard_extension\s*\(/.test(managed) &&
      /LogoutPolicy::for_platform\(target_url\)\.ok_or_else\(\|\|/.test(extensionCompact) &&
      /std::io::Error::new\(\s*std::io::ErrorKind::InvalidInput,/.test(extensionCompact) &&
      /"manifest_version":3,/.test(extensionCompact) &&
      /"run_at":"document_start","all_frames":false,"world":"MAIN"/.test(extensionCompact) &&
      /"matches":\[format!\("\{origin\}\/\*"\)\]/.test(extensionCompact) &&
      /std::fs::write\(extension_dir\.join\("guard\.js"\),policy\.login_guard_script\(\)\)\?;/.test(extensionCompact) &&
      (managed.match(/include_str!\("managed_cdp\/login_guard\.js"\)/g) || []).length === 1,
    "扩展目录只能由 policy 生成（MAIN 世界、document_start、仅登录 origin、单份模板），不支持的平台必须失败",
  );
  const rustBrowser = rustProduction(read("src-tauri/src/browser.rs"));
  const chromiumArgs = rustBody(rustBrowser, /\bfn\s+chromium_arguments\s*\(/);
  const chromiumArgsCompact = compact(chromiumArgs);
  assert(
    /login_guard_extension: Option<&Path>/.test(rustBrowser) &&
      /ifletSome\(extension\)=login_guard_extension\{/.test(chromiumArgsCompact) &&
      /"--load-extension=\{\}",/.test(chromiumArgsCompact) &&
      occurrences(chromiumArgsCompact, /--load-extension=\{\}/g) === 1 &&
      chromiumArgsCompact.indexOf('"--load-extension={}",') > chromiumArgsCompact.indexOf('"--window-size={}",') ,
    "chromium_arguments 必须只在提供扩展目录时追加一次 --load-extension，且位于起始网址之前",
  );
  assert(
    /BrowserError::LoginGuardExtension\(_\)=>CommandError::new\(/.test(compact(rustBody(rustCommandSource, /\bfn\s+managed_launch_command_error\s*\(/))) &&
      rustCommandSource.includes('"managed_guard_unavailable"'),
    "扩展准备失败必须 fail closed 并映射 managed_guard_unavailable，不得降级为通用启动错误",
  );

  // These checks are production-only: local fake-page tests may deliberately
  // use Runtime.evaluate/Input to prove that the guard blocks normal input.
  const commandSource = rustProduction(rustCommandSource);
  assert(
    !/"(?:Runtime|Input|DOM|DOMStorage|Fetch)\./.test(managed) &&
      !managed.includes('"Page.addScriptToEvaluateOnNewDocument"'),
    "managed_cdp.rs 只生成固定脚本与判定，不得自行发送页面命令",
  );
  assert(
    !/"(?:Runtime|Input|DOM|DOMStorage|Fetch)\./.test(commandSource) &&
      !commandSource.includes("Page.addScriptToEvaluateOnNewDocument"),
    "命令 IPC 不得绕开采集连接执行页面脚本或输入命令",
  );
  // 命令层只能在装配 ManagedWatch 时向 policy 要一次脚本，不能自带模板或注入点。
  const guardHandoff =
    /login_guard_script\s*:\s*managed_cdp\s*::\s*logout_guard_script\s*\(\s*&\s*session\s*\.\s*target_url\s*,?\s*\)/g;
  const handoffs = (commandSource.match(guardHandoff) || []).length;
  const mentions = (commandSource.match(/login_guard(_script)?\b/g) || []).length;
  // 结构体字段声明不算一次取值；命令层自己的 ManagedWatch 定义允许出现一次。
  const fieldDeclarations =
    (commandSource.match(/login_guard_script\s*:\s*String\b/g) || []).length;
  assert(
    handoffs >= 1 && mentions === handoffs + fieldDeclarations,
    "命令层只能通过 managed_cdp::logout_guard_script 取得固定 guard 脚本",
  );
  assert(
    !/__VESTUS_LOGIN_ROUTE__|login_guard\.js|include_str!|Page\s*\.\s*addScriptToEvaluateOnNewDocument/.test(commandSource),
    "命令 IPC 不得自带 guard 模板或自行安装脚本",
  );
  const guardProducer = compact(rustBody(managed, /\bfn\s+logout_guard_script\s*\(/));
  assert(
    /^LogoutPolicy::for_platform\(target_url\)\.map\(\|policy\|policy\.login_guard_script\(\)\)$/.test(
      guardProducer,
    ),
    "交给命令层的 guard 必须由固定 policy 生成",
  );
}

// 调试端点是活动采集的唯一通道，所以它开着（见 browser.rs 的「调试端点」一节）。
// 换来的收敛措施必须一条不少，否则这个端点就从「本机同用户可达」变成谁都可达。
// 只看 chromium_arguments 的函数体，且参数名带引号匹配：同一段的注释和下面的单元
// 测试都提到了这两个参数名——那是在说明为什么不传。
const rustBrowser = read("src-tauri/src/browser.rs").replace(/\r\n?/g, "\n");
const argumentsStart = rustBrowser.indexOf("fn chromium_arguments(");
const chromiumArguments = rustBrowser.slice(
  argumentsStart,
  rustBrowser.indexOf("\n}\n", argumentsStart)
);
assert(
  chromiumArguments.includes('"--remote-debugging-port=0"'),
  "DevTools 端口必须传 0 交给内核分配，写死端口就成了可预测的入口"
);
for (const forbidden of ["--remote-debugging-address", "--remote-allow-origins"]) {
  assert(
    !chromiumArguments.includes(`"${forbidden}`),
    `DevTools 端点放宽了 ${forbidden}，被打开的网页或别的机器就能连上采集通道`
  );
}

// 直连只有适配器一个执行点，其余模块不得绕开路由决策自行出站。
const rustSrcDir = new URL("src-tauri/src/", root);
for (const name of readdirSync(rustSrcDir).filter((file) => file.endsWith(".rs"))) {
  if (name === "adapter.rs" || name === "bypass.rs") continue;
  const source = readFileSync(new URL(`src-tauri/src/${name}`, root), "utf8");
  assert(!source.includes("direct.connect("), `${name} 绕开适配器直接发起直连`);
}

const desktopSource = [
  "src/App.tsx",
  "src/components/auth/LoginCard.tsx",
  "src/components/auth/ChangePasswordCard.tsx",
  "src/components/browser/PlatformLauncher.tsx",
  "src/components/layout/Header.tsx",
  "src/services/authService.ts",
  "src/services/tauriBridge.ts",
].map(read).join("\n");
for (const forbidden of [
  "loginRole",
  "后台管理员",
  "admin_dashboard",
  "/api/admin/auth/",
  "巨量广告授权",
  "批量改价",
]) {
  assert(!desktopSource.includes(forbidden), `桌面入口仍包含跨角色内容：${forbidden}`);
}

const assetsDir = new URL("dist/assets/", root);
const desktopBundle = readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(new URL(`dist/assets/${name}`, root), "utf8"))
  .join("\n");
for (const command of [
  "desktop_login",
  "desktop_restore_session",
  "desktop_logout",
  "desktop_product_name",
  "desktop_product_info",
  "desktop_change_password",
  "sync_desktop_config",
  "open_browser",
  "get_status",
]) {
  assert(desktopBundle.includes(command), `桌面产物缺少 Rust IPC：${command}`);
}
for (const forbidden of [
  "/api/admin/auth/login",
  "/api/user/auth/login",
  "客户 / 管理员身份登录",
  "admin_dashboard",
  "巨量广告授权",
  "批量改价",
  "close_browser",
  "stop_proxy",
  "run_page_script",
  "browser_navigate",
  "browser_back",
  "browser_forward",
  "browser_reload",
]) {
  assert(!desktopBundle.includes(forbidden), `桌面产物包含不应出现的内容：${forbidden}`);
}

console.log("surface boundaries: ok");
