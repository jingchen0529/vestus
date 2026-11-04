import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("编辑已有账号时只在创建模式要求同时填写账号和密码", async () => {
  const source = await readFile(
    path.join(webRoot, "src/components/users/managed-account-dialog.tsx"),
    "utf8",
  );

  assert.match(
    source,
    /if \(formMode === "create"\) \{[\s\S]*?authMode === "server_login"[\s\S]*?Boolean\(parsedPayload\.username\) !== Boolean\(parsedPayload\.password\)/,
  );
});

test("绑定列表刷新对同一账号只允许一个请求在途", async () => {
  const source = await readFile(path.join(webRoot, "src/App.tsx"), "utf8");

  assert.match(source, /const managedBindingsLoadRef = useRef</);
  assert.match(
    source,
    /current\.inFlight && current\.viewer === requestViewer/,
  );
  assert.match(source, /managedBindingsLoadRef\.current = \{ viewer: requestViewer, inFlight: null \}/);
});
