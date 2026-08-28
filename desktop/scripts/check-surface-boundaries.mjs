import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

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

// 页面自动化已移除：不得再参与编译，也不得再开调试端点。
for (const removed of ["mod page;", "mod cdp;"]) {
  assert(!rustCommands.includes(removed), `页面自动化模块又参与编译了：${removed}`);
}
assert(
  !rustCommands.includes("commands::run_page_script"),
  "Rust 仍注册页面自动化 IPC：run_page_script"
);
const rustBrowser = read("src-tauri/src/browser.rs");
assert(
  !rustBrowser.includes('OsString::from("--remote-debugging-port'),
  "浏览器又开了 DevTools 调试端点，页面自动化已移除，不需要本地控制通道"
);

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
