import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTauriArguments,
  buildTauriConfigForApi,
} from "./tauri-with-api.mjs";

function directives(csp) {
  return new Map(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name, sources])
  );
}

test("base Tauri CSP does not permit inline data images or WebView API requests", () => {
  const config = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
  );
  const policy = directives(config.app.security.csp);

  assert.deepEqual(policy.get("img-src"), ["'self'"]);
  assert.deepEqual(policy.get("connect-src"), ["'self'", "ipc:", "http://ipc.localhost"]);
});

test("generated Tauri CSP permits images from only the exact API origin", () => {
  const merge = buildTauriConfigForApi(
    "https://api.example.test:8443/vestus"
  );
  const policy = directives(merge.app.security.csp);

  assert.deepEqual(policy.get("img-src"), [
    "'self'",
    "https://api.example.test:8443",
  ]);
  assert.deepEqual(policy.get("connect-src"), [
    "'self'",
    "ipc:",
    "http://ipc.localhost",
  ]);
  assert.equal(policy.get("img-src").includes("data:"), false);
  assert.equal(policy.get("img-src").includes("https:"), false);
  assert.equal(policy.get("img-src").some((source) => source.includes("*")), false);
});

test("Tauri CSP generator rejects API bases that cannot be pinned safely", () => {
  for (const value of [
    "https://user:pass@api.example.test",
    "https://api.example.test?tenant=one",
    "https://api.example.test#fragment",
    "file:///tmp/api",
    "http://api.example.test",
  ]) {
    assert.throws(
      () => buildTauriConfigForApi(value),
      undefined,
      `应当拒绝 API 地址：${value}`
    );
  }
  assert.doesNotThrow(() =>
    buildTauriConfigForApi("http://127.0.0.1:8000")
  );
});

test("remote HTTP API requires the explicit insecure-build switch", () => {
  assert.throws(
    () => buildTauriConfigForApi("http://api.example.test/vestus"),
    /非本机地址必须使用 HTTPS/
  );

  const merge = buildTauriConfigForApi(
    "http://api.example.test:8080/vestus",
    { allowInsecureApi: true }
  );
  assert.deepEqual(
    directives(merge.app.security.csp).get("img-src"),
    ["'self'", "http://api.example.test:8080"]
  );
});

test("Tauri wrapper passes the generated merge through the official config option", () => {
  const args = buildTauriArguments(
    ["build", "--target", "x86_64-unknown-linux-gnu"],
    "https://api.example.test/vestus"
  );

  assert.equal(args[0], "build");
  assert.equal(args[1], "--config");
  assert.deepEqual(JSON.parse(args[2]),
    buildTauriConfigForApi("https://api.example.test/vestus")
  );
  assert.deepEqual(args.slice(3), ["--target", "x86_64-unknown-linux-gnu"]);
});

test("desktop build package command enforces API pinning before invoking Tauri", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "desktop:build", "--", "--help"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VESTUS_API_BASE_URL: "http://api.example.test",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /非本机地址必须使用 HTTPS/
  );
});

test("release workflow cannot bypass the API-pinned Tauri wrapper", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8"
  );

  assert.match(
    workflow,
    /npm run desktop:build -- --target "?\$\{\{ matrix\.rust_target \}\}"?/
  );
  assert.match(
    workflow,
    /npm test && npm run build && npm run check:surfaces/,
    "前端验证命令必须短路，任一命令失败都要让矩阵任务失败"
  );
  assert.doesNotMatch(workflow, /npx tauri build/);
  assert.match(
    workflow,
    /http:\/\/\*\)[\s\S]{0,500}if \[ "\$release" = true \]; then[\s\S]{0,500}exit 1[\s\S]{0,500}VESTUS_ALLOW_INSECURE_API=1/,
    "只有非标签的手工 HTTP 构建可以显式开启不安全 API"
  );
});
