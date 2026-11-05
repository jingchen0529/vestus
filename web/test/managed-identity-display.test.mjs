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

test("旧账号缺少最近检查字段时保持正常展示，不虚构检查时间", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  assert.deepEqual(managedIdentityDisplay({
    authMode: "cookie",
    sessionStatus: "valid",
    identityCheckedAt: "2026-11-01T01:00:00Z",
  }), {
    label: "会话正常",
    variant: "outline",
    recovering: false,
    detail: null,
    checkedAt: null,
    verifiedAt: "2026-11-01T01:00:00Z",
  });
});

test("最近检查不可达时有效会话显示待确认黄标，并保留独立成功时间", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  assert.deepEqual(managedIdentityDisplay({
    authMode: "cookie",
    sessionStatus: "valid",
    identityCheckedAt: "2026-11-01T01:00:00Z",
    lastIdentityCheckState: "unavailable",
    lastIdentityCheckAt: "2026-11-05T02:00:00Z",
    lastIdentityCheckDetail: "上游身份接口暂不可用（HTTP 503）",
  }), {
    label: "校验失败／待确认",
    variant: "warning",
    recovering: false,
    detail: "上游身份接口暂不可用（HTTP 503）",
    checkedAt: "2026-11-05T02:00:00Z",
    verifiedAt: "2026-11-01T01:00:00Z",
  });
});

test("过期 Cookie 不会因最近检查结论而恢复，始终提示替换", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  for (const lastIdentityCheckState of ["verified", "invalid", "unavailable", null, undefined]) {
    const display = managedIdentityDisplay({
      authMode: "cookie",
      sessionStatus: "expired",
      lastIdentityCheckState,
      lastIdentityCheckDetail: "本次身份检查未改变已有会话状态",
    });
    assert.equal(display.label, "会话已失效");
    assert.equal(display.variant, "destructive");
    assert.equal(display.detail, "本次身份检查未改变已有会话状态；请替换 Cookie 后重试");
  }
});

test("旧身份验证成功不能掩盖客户端已上报的失效原因", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");
  const display = managedIdentityDisplay({
    authMode: "cookie", sessionStatus: "expired",
    lastIdentityCheckState: "verified", lastIdentityCheckDetail: "登录态有效",
    lastError: "客户端已上报退出登录",
  });
  assert.equal(display.detail, "客户端已上报退出登录；请替换 Cookie 后重试");
});

test("过期账号密码会话提示恢复或重新登录，不要求替换 Cookie", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  const account = { authMode: "server_login", sessionStatus: "expired" };
  assert.equal(managedIdentityDisplay(account).detail, "请检查账号密码并重新登录");
  assert.equal(
    managedIdentityDisplay({ ...account, autoRelogin: true }).detail,
    "请等待自动恢复，若持续失败请检查账号密码",
  );
  assert.equal(managedIdentityDisplay({ sessionStatus: "expired" }).detail, "请重新登录后重试");
});

test("自动恢复中的徽标优先于过期与最近检查不可达", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  for (const [recoveryStatus, label] of [
    ["pending", "等待自动登录"],
    ["running", "自动登录中"],
    ["retry_wait", "等待自动重试（已尝试 2 次）"],
  ]) {
    const display = managedIdentityDisplay({
      authMode: "server_login",
      sessionStatus: "expired",
      lastIdentityCheckState: "unavailable",
      lastIdentityCheckDetail: "上游暂不可达",
      autoRelogin: true,
      recoveryStatus,
      recoveryAttempts: 2,
      lastError: "恢复任务等待重试",
    });
    assert.equal(display.label, label);
    assert.equal(display.variant, "warning");
    assert.equal(display.recovering, true);
    assert.equal(display.detail, "恢复任务等待重试");
  }
});

test("自动恢复失败继续优先显示失败与人工处理原因", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  const display = managedIdentityDisplay({
    authMode: "server_login",
    sessionStatus: "expired",
    lastIdentityCheckState: "unavailable",
    lastIdentityCheckDetail: "上游暂不可达",
    recoveryStatus: "failed",
    lastError: "需要人工完成身份验证",
  });
  assert.equal(display.label, "自动恢复失败");
  assert.equal(display.variant, "destructive");
  assert.equal(display.recovering, false);
  assert.equal(display.detail, "需要人工完成身份验证");
});

test("身份检查通过的有效会话显示成功消息，并兼容旧响应", async () => {
  const { managedIdentityCheckToast } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  for (const sessionStatus of ["valid", undefined]) {
    assert.deepEqual(managedIdentityCheckToast({
      state: "verified",
      detail: "身份已核实",
      account: { authMode: "cookie", sessionStatus, remoteDisplayName: "测试身份" },
    }), { level: "success", message: "登录态有效：测试身份" });
  }
});

test("身份检查通过但 Cookie 仍过期时不提示成功，保留替换说明", async () => {
  const { managedIdentityCheckToast } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  assert.deepEqual(managedIdentityCheckToast({
    state: "verified",
    detail: "身份已确认，但旧会话不会恢复，请替换 Cookie",
    account: { authMode: "cookie", sessionStatus: "expired", remoteDisplayName: "测试身份" },
  }), {
    level: "warning",
    message: "身份已确认，会话仍失效",
    description: "身份已确认，但旧会话不会恢复，请替换 Cookie",
  });
});

test("确定失效的检查提示错误，Cookie 替换与账号密码恢复分别引导", async () => {
  const { managedIdentityCheckToast } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  assert.deepEqual(managedIdentityCheckToast({
    state: "invalid", detail: "",
    account: { authMode: "cookie", sessionStatus: "expired" },
  }), {
    level: "error",
    message: "登录态已失效，会话已标记过期",
    description: "请替换 Cookie 后重试",
  });
  assert.deepEqual(managedIdentityCheckToast({
    state: "invalid", detail: "",
    account: {
      authMode: "server_login", sessionStatus: "expired",
      autoRelogin: true, recoveryStatus: "pending",
    },
  }), {
    level: "error",
    message: "登录态已失效，等待自动登录",
    description: "等待自动登录",
  });
});

test("检查返回 503 时只提示待确认与脱敏原因，不宣称会话失效", async () => {
  const { managedIdentityCheckErrorToast } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  const error = Object.assign(new Error("上游身份接口暂不可用（HTTP 503）"), { status: 503 });
  assert.deepEqual(managedIdentityCheckErrorToast(error), {
    level: "warning",
    message: "校验失败／待确认",
    description: "上游身份接口暂不可用（HTTP 503）",
  });
});

test("非 503 的检查失败保留错误提示，未知异常提供重试提示", async () => {
  const { managedIdentityCheckErrorToast } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  assert.deepEqual(managedIdentityCheckErrorToast(new Error("没有检查权限")), {
    level: "error", message: "检查登录态失败", description: "没有检查权限",
  });
  assert.deepEqual(managedIdentityCheckErrorToast(null), {
    level: "error", message: "检查登录态失败", description: "请稍后重试",
  });
});

test("旧过期账号保留失效原因，空的检查字段不覆盖既有说明", async () => {
  const { managedIdentityDisplay } = await server.ssrLoadModule("/src/lib/managed-identity-display.ts");

  assert.equal(managedIdentityDisplay({
    authMode: "cookie", sessionStatus: "expired",
    lastError: "客户端已上报退出登录",
    lastIdentityCheckState: null,
    lastIdentityCheckAt: null,
    lastIdentityCheckDetail: null,
  }).detail, "客户端已上报退出登录；请替换 Cookie 后重试");
});

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
