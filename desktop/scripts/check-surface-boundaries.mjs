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
const compact = (source) => (source.match(/"(?:\\.|[^"\\])*"|\S/g) || []).join("");

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

// 采集通道只允许固定计数脚本，不得驱动页面。托管 login guard 另走 managed_cdp；
// 它不是给采集通道或前端增加任意脚本入口的例外。脚本读取内容由各自单元测试守。
const rustCdp = rustProduction(read("src-tauri/src/cdp.rs"));
// 按 collect 和 Collector 的代码块检查，覆盖 install/resume 等拆出的 helper，
// 不吞掉本地 #[cfg(test)]，也不涉及另一条一次性浏览器生命周期控制连接。
const collectSurface =
  rustBody(rustCdp, /\bpub\s+async\s+fn\s+collect\s*\(/) +
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
// 新 target 由它暂停、装完采集脚本与固定 guard 后再放行。独立的第二条防护连接
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

  // 单连接模型：采集连接暂停所有新 target，装完两个固定脚本后才放行。
  const openingCommands = rustBody(rustCdp, /\bfn\s+opening_commands\s*\(/);
  assert(
    /"autoAttach"\s*:\s*true\b/.test(openingCommands) &&
      /"waitForDebuggerOnStart"\s*:\s*true\b/.test(openingCommands) &&
      /"flatten"\s*:\s*true\b/.test(openingCommands),
    "采集连接必须暂停新 target（waitForDebuggerOnStart: true）才能安装固定防护",
  );

  const installBody = rustBody(rustCdp, /\bfn\s+install\s*\(/);
  const documentScripts = (installBody.match(/"Page\.addScriptToEvaluateOnNewDocument"/g) || []).length;
  assert(
    documentScripts === 2,
    "采集连接只允许安装采集脚本与固定 guard 两个文档脚本",
  );
  assert(
    /"source"\s*:\s*COLLECTOR_SCRIPT\b/.test(installBody),
    "采集脚本必须来自固定常量 COLLECTOR_SCRIPT",
  );
  assert(
    /"source"\s*:\s*managed\s*\.\s*login_guard_script\b/.test(installBody),
    "托管 guard 必须由采集连接安装，且 source 只能来自 policy 生成的固定字段",
  );
  assert(
    (installBody.match(/"source"\s*:/g) || []).length === 2,
    "文档脚本只能来自固定常量或 policy 生成的 guard，不能使用前端动态 source",
  );
  const enableAt = installBody.indexOf('"Page.enable"');
  const guardAt = installBody.indexOf("managed.login_guard_script");
  const resumeAt = installBody.indexOf('"Runtime.runIfWaitingForDebugger"');
  assert(
    enableAt >= 0 && guardAt > enableAt && resumeAt > guardAt,
    "固定 guard 必须在 Page.enable 之后、放行之前安装",
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
