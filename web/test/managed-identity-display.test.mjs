import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  appType: "custom",
  configFile: false,
  root: webRoot,
  cacheDir: path.join(webRoot, "node_modules/.vite/managed-identity-test"),
  plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": path.join(webRoot, "src") } },
  server: { hmr: false, middlewareMode: true, ws: false },
});
after(async () => server.close());

test("绑定总览展示远端身份并提供「检查登录态」操作", async () => {
  const source = await readFile(
    path.join(webRoot, "src/components/managed-platforms/managed-bindings-view.tsx"),
    "utf8",
  );
  // 托管账号单元格渲染平台侧身份（与账号名去重），且身份副标题可点击重新校验。
  assert.match(source, /\{item\.remoteDisplayName && item\.remoteDisplayName !== item\.name \? \(/);
  assert.match(source, /平台身份：\$\{item\.remoteDisplayName\}；点击重新校验登录态/);
  assert.match(source, /onClick=\{\(\) => void handleCheckIdentity\(item\)\}/);
  // 检查登录态支持 Cookie 与服务端登录模式（自动恢复中除外），且走统一的回调。
  assert.match(source, /onCheckIdentity && item\.authMode !== "official_sso" && !isManagedRecovering\(item\)/);
  assert.match(source, /await onCheckIdentity\(item\.managedAccountId\)/);
  assert.match(source, /登录态有效：\$\{result\.account\.remoteDisplayName/);
  assert.match(source, /登录态已失效，会话已标记过期/);
  assert.match(source, /检查登录态失败/);
  // 探测完成后刷新列表。
  assert.match(source, /onRefresh\(\);/);
});

test("账号池视图复用远端身份副标题与检查入口", async () => {
  const source = await readFile(
    path.join(webRoot, "src/components/managed-platforms/managed-platforms-view.tsx"),
    "utf8",
  );
  assert.match(source, /\{account\.remoteDisplayName \|\| "密钥已托管，不回显"\}/);
  assert.match(source, /onCheckIdentity && account\.authMode === "cookie"/);
  assert.match(source, /await onCheckIdentity\(account\.id\)/);
  assert.match(source, /检查中…/);
});

test("编辑弹窗摘要展示远端身份与检测时间", async () => {
  const source = await readFile(
    path.join(webRoot, "src/components/managed-platforms/managed-binding-dialog.tsx"),
    "utf8",
  );
  assert.match(source, /远端身份/);
  assert.match(source, /bindingToEdit\.remoteDisplayName/);
  assert.match(source, /bindingToEdit\.identityCheckedAt/);
  assert.match(source, /尚未探测/);
});

test("api-client 提供 identity-check 调用且仅超管接线", async () => {
  const apiClient = await readFile(path.join(webRoot, "src/lib/api-client.ts"), "utf8");
  assert.match(apiClient, /checkManagedAccountIdentity\(id: number\)/);
  assert.match(apiClient, /\/identity-check`/);
  assert.match(apiClient, /method: "POST"/);

  const app = await readFile(path.join(webRoot, "src/App.tsx"), "utf8");
  assert.match(app, /handleCheckManagedAccountIdentity = useCallback/);
  assert.match(
    app,
    /onCheckIdentity=\{isSuperAdmin \? handleCheckManagedAccountIdentity : undefined\}/,
  );
});

test("用户绑定列表提供检查入口且检查后刷新绑定", async () => {
  const dialog = await readFile(
    path.join(webRoot, "src/components/users/managed-account-dialog.tsx"),
    "utf8",
  );
  // 列表操作列的检查按钮：非官方 SSO 模式 + 提供回调时显示。
  assert.match(dialog, /onCheckIdentity && resolvedAuthMode !== "official_sso"/);
  assert.match(dialog, /await onCheckIdentity\(item\.managedAccountId\)/);
  assert.match(dialog, /检查中…/);
  assert.match(dialog, /登录态有效：\$\{result\.account\.remoteDisplayName/);
  // 身份副标题仍然展示，但与账号名相同时去重不重复渲染。
  assert.match(dialog, /\{item\.remoteDisplayName && item\.remoteDisplayName !== item\.name \? \(/);
  assert.match(dialog, /平台身份：\$\{item\.remoteDisplayName\}/);

  const usersView = await readFile(path.join(webRoot, "src/components/users/users-view.tsx"), "utf8");
  // 检查完成后刷新弹窗绑定列表。
  assert.match(usersView, /const handleCheckManagedIdentity = async \(managedAccountId: number\)/);
  assert.match(usersView, /await refreshManagedBindingsForUser\(managedUser\.id\)/);
  assert.match(usersView, /onCheckIdentity=\{onCheckIdentity \? handleCheckManagedIdentity : undefined\}/);

  const app = await readFile(path.join(webRoot, "src/App.tsx"), "utf8");
  // UsersView 也接线超管检查回调。
  assert.match(
    app,
    /onCheckIdentity=\{isSuperAdmin \? handleCheckManagedAccountIdentity : undefined\}/,
  );
});
