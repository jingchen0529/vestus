import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  appType: "custom", configFile: false, root: webRoot,
  cacheDir: path.join(webRoot, "node_modules/.vite/password-charset-test"),
  plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": path.join(webRoot, "src") } },
  server: { hmr: false, middlewareMode: true, ws: false },
});
after(() => server.close());

test("密码过滤与桌面端一致：只保留可见 ASCII，剔除中文空格全角与 emoji", async () => {
  const { sanitizePasswordChars } = await server.ssrLoadModule("/src/lib/password-policy.ts");
  assert.equal(sanitizePasswordChars("Passw0rd!@#"), "Passw0rd!@#");
  assert.equal(sanitizePasswordChars("密码123"), "123");
  assert.equal(sanitizePasswordChars("abc中文def"), "abcdef");
  assert.equal(sanitizePasswordChars("pass word"), "password");
  assert.equal(sanitizePasswordChars("pass\u3000word"), "password");
  assert.equal(sanitizePasswordChars("pass😀word"), "password");
  assert.equal(sanitizePasswordChars("ｐａｓｓword"), "word");
  assert.equal(sanitizePasswordChars(""), "");
});

test("提交前能识别仍含非 ASCII 的密码，给出与桌面端相同口径的提示", async () => {
  const { passwordCharsetError } = await server.ssrLoadModule("/src/lib/password-policy.ts");
  assert.equal(passwordCharsetError("Passw0rd!"), null);
  assert.match(passwordCharsetError("中文密码123"), /可见 ASCII/);
  assert.match(passwordCharsetError("pass word"), /可见 ASCII/);
});

test("账号白名单与桌面端相同，姓名不使用登录字段规则", async () => {
  const { sanitizeAccountChars, accountCharsetError } = await server.ssrLoadModule("/src/lib/password-policy.ts");
  assert.equal(sanitizeAccountChars("ops.user_01@corp-x"), "ops.user_01@corp-x");
  assert.equal(sanitizeAccountChars("客户client 01😀/"), "client01");
  assert.equal(accountCharsetError("client01"), null);
  assert.match(accountCharsetError("客户01"), /账号/);
});

test("输入与粘贴过滤非法字符时明确提示，输入法组合不会留下拼音或中文", async () => {
  const { restrictedCredentialInput } = await server.ssrLoadModule("/src/lib/credential-input.ts");
  let value = "Pass123!";
  const notices = [];
  const handlers = restrictedCredentialInput("password", value, next => { value = next; }, message => notices.push(message));
  const input = { value: "Pass123!中文" };
  handlers.onChange({ currentTarget: input, nativeEvent: { isComposing: false } });
  assert.equal(value, "Pass123!");
  assert.equal(input.value, "Pass123!");
  assert.match(notices[0], /中文/);
  input.value = "Pass123!zhong";
  handlers.onChange({ currentTarget: input, nativeEvent: { isComposing: true } });
  assert.equal(value, "Pass123!");
  assert.equal(input.value, "Pass123!");
  input.value = "Pass123!文";
  handlers.onCompositionEnd({ currentTarget: input });
  assert.equal(value, "Pass123!");
  assert.equal(input.value, "Pass123!");
  let prevented = false;
  handlers.onKeyDown({ key: " ", nativeEvent: {}, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test("组合输入被回滚后结束事件不会清掉拒绝提示", async () => {
  const { restrictedCredentialInput } = await server.ssrLoadModule("/src/lib/credential-input.ts");
  let error = null;
  let commits = 0;
  const handlers = restrictedCredentialInput("password", "Pass123!", () => { commits += 1; error = null; }, message => { error = message; });
  const input = { value: "Pass123!zhong" };
  handlers.onChange({ currentTarget: input, nativeEvent: { isComposing: true } });
  assert.match(error, /中文/);
  handlers.onCompositionEnd({ currentTarget: input });
  assert.equal(commits, 0);
  assert.match(error, /中文/);
});

test("随机密码只会生成桌面端可输入的字符，并保持四类字符都存在", async () => {
  const { generateRandomPassword } = await server.ssrLoadModule("/src/lib/utils.ts");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const password = generateRandomPassword(12);
    assert.equal(password.length, 12);
    assert.match(password, /^[\x21-\x7E]+$/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[!@#$%^&*]/);
  }
});
