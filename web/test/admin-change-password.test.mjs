import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  appType: "custom",
  configFile: false,
  root: webRoot,
  cacheDir: path.join(webRoot, "node_modules/.vite/admin-change-password-test"),
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": path.join(webRoot, "src") } },
  server: { hmr: false, middlewareMode: true, ws: false },
});
after(() => server.close());

function envelope(data, status = 200, code = 0, msg = "ok") {
  return new Response(JSON.stringify({ code, msg, data, requestId: "password-test" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("表单接受 6–256 位新密码并保留密码首尾空格", async () => {
  const { validateChangePassword } = await server.ssrLoadModule("/src/components/auth/change-password-form.ts");
  for (const newPassword of ["123456", "a".repeat(256), " new password "]) {
    const fields = { currentPassword: " old password ", newPassword, confirmPassword: newPassword };
    const original = { ...fields };
    assert.equal(validateChangePassword(fields), null);
    assert.deepEqual(fields, original);
  }
});

test("表单拒绝缺失当前密码及不满足 6–256 位的新密码", async () => {
  const { validateChangePassword } = await server.ssrLoadModule("/src/components/auth/change-password-form.ts");
  assert.equal(validateChangePassword({ currentPassword: "", newPassword: "123456", confirmPassword: "123456" }), "请输入当前密码");
  for (const newPassword of ["", "12345", "a".repeat(257)]) {
    assert.equal(validateChangePassword({ currentPassword: "old-password", newPassword, confirmPassword: newPassword }), "新密码长度须为 6–256 位");
  }
});

test("表单要求新旧密码不同且确认密码逐字一致", async () => {
  const { validateChangePassword } = await server.ssrLoadModule("/src/components/auth/change-password-form.ts");
  assert.equal(validateChangePassword({ currentPassword: "same-password", newPassword: "same-password", confirmPassword: "same-password" }), "新密码不能与当前密码相同");
  for (const confirmPassword of ["", "new-password ", "different-password"]) {
    assert.equal(validateChangePassword({ currentPassword: "old-password", newPassword: "new-password", confirmPassword }), "两次输入的新密码不一致");
  }
  assert.equal(validateChangePassword({ currentPassword: "new-password", newPassword: "new-password ", confirmPassword: "new-password " }), null);
});

test("修改密码仅发送两个原始密码字段，失败保留会话，成功清 token 且不调用 logout", async () => {
  const { api, setAuthToken } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const requests = [];
  let failure = null;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, ...init });
    if (String(url).endsWith("/change-password")) {
      if (failure instanceof Error) throw failure;
      if (failure) return envelope(null, failure.status, failure.code, "当前密码错误");
    }
    return envelope(null);
  };
  const payload = { currentPassword: " old password ", newPassword: " new password ", confirmPassword: "never-send", role: "super_admin" };
  try {
    setAuthToken("old-session");
    for (failure of [
      { status: 400, code: 40000 },
      { status: 401, code: 40100 },
      { status: 403, code: 40300 },
      { status: 422, code: 42200 },
      { status: 429, code: 42900 },
      { status: 500, code: 50000 },
      { status: 200, code: 40000 },
      new Error("网络连接失败"),
    ]) {
      await assert.rejects(api.changeAdminPassword(payload), /当前密码错误|网络连接失败/);
      await api.getMe();
      assert.equal(requests.at(-1).headers.Authorization, "Bearer old-session");
    }
    failure = null;
    await api.changeAdminPassword(payload);
    const changeRequest = requests.at(-1);
    assert.equal(changeRequest.url, "/api/admin/auth/change-password");
    assert.equal(changeRequest.method, "POST");
    assert.equal(changeRequest.credentials, "include");
    assert.equal(changeRequest.headers.Authorization, "Bearer old-session");
    assert.deepEqual(JSON.parse(changeRequest.body), {
      currentPassword: " old password ", newPassword: " new password ",
    });
    await api.getMe();
    assert.equal(requests.at(-1).headers.Authorization, undefined);
    assert.equal(requests.some(({ url }) => String(url).endsWith("/logout")), false);
  } finally {
    setAuthToken(null);
    globalThis.fetch = originalFetch;
  }
});
