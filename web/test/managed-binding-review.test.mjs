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
  cacheDir: path.join(webRoot, "node_modules/.vite/managed-binding-test"),
  plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": path.join(webRoot, "src") } },
  server: { hmr: false, middlewareMode: true, ws: false },
});
after(async () => server.close());

const form = await server.ssrLoadModule("/src/components/managed-platforms/managed-binding-form.ts");
const account = (id, changes = {}) => ({
  id, platformId: 1, status: "active", sessionStatus: "valid", name: `account-${id}`,
  authMode: "cookie", allowedHosts: [], credentialVersion: 1, ...changes,
});

test("已有账号候选排除跨平台、失效、过期与当前用户已绑定项", () => {
  const accounts = [
    account(1), account(2, { platformId: 2 }), account(3, { status: "revoked" }),
    account(4, { sessionStatus: "expired" }), account(5, { expiresAt: "2020-01-01" }),
    account(6), account(7), account(8, { expiresAt: "invalid-date" }),
  ];
  const bindings = [
    { userId: 10, managedAccountId: 6, status: "active" },
    { userId: 11, managedAccountId: 7, status: "active" },
  ];
  assert.deepEqual(form.bindableAccounts(accounts, bindings, 10, Date.parse("2026-11-03"))
    .map(({ id }) => id), [1, 7]);
  assert.deepEqual(form.bindableAccounts([account(6)], [{ ...bindings[0], status: "revoked" }], 10)
    .map(({ id }) => id), [6]);
});

test("选择已有账号只调用绑定接口，不构建或回传凭据", async () => {
  const calls = [];
  await form.submitNewBinding({
    source: "existing", userId: 10, accountId: 7, candidates: [account(7)],
    buildPayload() { throw new Error("must not inspect cookie fields"); },
    async onCreateAccount() { assert.fail("must not create an account"); },
    async onBindAccount(...args) { calls.push(args); },
  });
  assert.deepEqual(calls, [[10, 7]]);
});

test("创建新账号保留创建路径，不错误调用绑定已有账号", async () => {
  const payload = { authMode: "cookie", cookieBundle: [{ name: "sid", value: "test", domain: "example.test" }] };
  const calls = [];
  await form.submitNewBinding({
    source: "create", userId: 10, candidates: [], buildPayload: () => payload,
    async onCreateAccount(...args) { calls.push(args); },
    async onBindAccount() { assert.fail("must not bind existing account"); },
  });
  assert.deepEqual(calls, [[10, payload]]);
});

test("已有账号选择失效、缺少回调或服务端拒绝时不降级为创建", async () => {
  const options = {
    source: "existing", userId: 10, accountId: 7, candidates: [account(7)],
    buildPayload() { assert.fail("must not build credentials"); },
    async onCreateAccount() { assert.fail("must not create"); },
  };
  await assert.rejects(form.submitNewBinding(options), /不支持绑定/);
  await assert.rejects(form.submitNewBinding({ ...options, candidates: [], onBindAccount: async () => assert.fail() }), /请选择/);
  await assert.rejects(form.submitNewBinding({ ...options, onBindAccount: async () => { throw new Error("permission denied"); } }), /permission denied/);
});

test("bindings 菜单和直链共用超管权限策略", async () => {
  const { isSuperAdminTab } = await server.ssrLoadModule("/src/components/layout/sidebar.tsx");
  assert.equal(isSuperAdminTab("bindings"), true);
  assert.equal(isSuperAdminTab("users"), false);
  const app = await readFile(path.join(webRoot, "src/App.tsx"), "utf8");
  const sidebar = await readFile(path.join(webRoot, "src/components/layout/sidebar.tsx"), "utf8");
  assert.match(app, /if \(isSuperAdminTab\(currentTab\)\)/);
  assert.match(sidebar, /!isSuperAdminTab\(item.id\) \|\| isSuperAdmin/);
  assert.match(app, /managedViewerRef.current === managedViewer/);
  assert.match(app, /availableManagedAccounts=\{isSuperAdmin \? managedAccounts : \[\]\}/);
});

test("新增表单连接来源选项、提交门闩和过期详情回调保护", async () => {
  const source = await readFile(path.join(webRoot, "src/components/managed-platforms/managed-binding-dialog.tsx"), "utf8");
  assert.match(source, /value="existing" disabled=\{!onBindAccount\}/);
  assert.match(source, /await submitNewBinding\(/);
  assert.match(source, /submittingRef.current \|\| detailLoading \|\| detailError/);
  assert.match(source, /if \(!active\) return/);
  assert.match(source, /setSelectedAccountId\(""\)/);
});
