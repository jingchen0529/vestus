import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess } from "./process-tree.mjs";

function boundary({ flips = true, cleanupFailure = false } = {}) {
  let devtools, browser, profile, fixtureUrl;
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    if (command === process.execPath) {
      browser = child;
      if (cleanupFailure) child.pid = 7654;
      profile = args.find((arg) => arg.startsWith("--user-data-dir=")).split("=")[1];
      fixtureUrl = args.at(-1);
      assert.equal(args.includes("--no-sandbox"), false);
      assert.equal(args.includes("--remote-debugging-address=127.0.0.1"), true);
      assert.equal(options.detached, true);
      devtools = createServer((_req, res) => res.end(JSON.stringify([{ id: "owned-page", type: "page", url: fixtureUrl }])));
      devtools.listen(0, "127.0.0.1", async () => {
        writeFileSync(join(profile, "DevToolsActivePort"), `${devtools.address().port}\n/devtools/browser/owned\n`);
        const html = await (await fetch(fixtureUrl)).text();
        const nonce = html.match(/const nonce = "([a-f0-9]+)"/)[1];
        await fetch(new URL("ready", fixtureUrl), { method: "POST", body: JSON.stringify({ nonce, complete: true, visibility: "visible", width: 1200, height: 800 }) });
      });
      return child;
    }
    assert.equal(command, "cargo");
    assert.equal(options.env.VESTUS_MATERIAL_TARGET_ID, "owned-page");
    assert.equal(options.env.VESTUS_MATERIAL_VARIANT, "A");
    assert.equal(options.env.VESTUS_MATERIAL_OPEN_SELECTOR, undefined);
    queueMicrotask(async () => {
      if (flips) {
        const html = await (await fetch(fixtureUrl)).text();
        const nonce = html.match(/const nonce = "([a-f0-9]+)"/)[1];
        for (let sequence = 1; sequence <= 60; sequence++) {
          const next = sequence % 2 === 1;
          await fetch(new URL("event", fixtureUrl), { method: "POST", body: JSON.stringify({ nonce, sequence, direction: next ? "next" : "prev", from: next ? 1 : 2, to: next ? 2 : 1 }) });
        }
      }
      writeFileSync(options.env.VESTUS_MATERIAL_RESULT, JSON.stringify({ variant: "A", rounds: 30, samples: Array(31).fill({ round: 0 }) }));
      child.stdout.emit("data", "test cdp::control_tests::material_selection_30_flip_regression ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;\n");
      child.emit("close", 0, null);
      browser.emit("close", 0, null);
    });
    return child;
  };
  return { spawnProcess, get profile() { return profile; }, async finish() {
    if (devtools) await new Promise((resolve) => { devtools.close(resolve); devtools.closeAllConnections(); });
    if (browser) browser.emit("close", 0, null);
  } };
}

test("smoke public runner reuses cargo, requires independent 60 flips, and deletes only its owned profile", { timeout: 5_000 }, async () => {
  const { runMaterialSmoke } = await import("./test-browser-material-smoke.mjs");
  const root = mkdtempSync(join(tmpdir(), "vestus-smoke-test-"));
  const fake = boundary();
  try {
    const status = await runMaterialSmoke({ env: { VESTUS_MATERIAL_URL: "https://must-not-use.example/", VESTUS_MATERIAL_OPEN_SELECTOR: "#must-not-use" },
      chromium: process.execPath, resultDir: join(root, "results"), timeoutMs: 2_000,
      platform: "linux", spawnProcess: fake.spawnProcess, stdout: { write() {} }, stderr: { write() {} },
    });
    assert.equal(status, 0);
    const report = JSON.parse(readFileSync(join(root, "results", "smoke.json"), "utf8"));
    assert.equal(report.mode, "synthetic-smoke");
    assert.equal(report.memoryAcceptance, false);
    assert.equal(report.gui, "not-run");
    assert.equal(report.login, "not-run");
    assert.equal(report.observedPageFlips, 60);
    assert.equal(report.rounds, 30);
    assert.equal(report.sampleCount, 31);
    assert.equal(report.cleanup.passed, true);
    assert.equal(report.cleanup.ownedRootRemoved, true);
    assert.equal(existsSync(fake.profile), false);
    assert.equal(JSON.stringify(report).includes("must-not-use"), false);
    assert.equal(JSON.stringify(report).includes(fake.profile), false);
  } finally { await fake.finish(); rmSync(root, { recursive: true, force: true }); }
});


test("smoke rejects cargo success without actual fixture page transitions", { timeout: 5_000 }, async () => {
  const { runMaterialSmoke } = await import("./test-browser-material-smoke.mjs");
  const root = mkdtempSync(join(tmpdir(), "vestus-smoke-test-")); const fake = boundary({ flips: false });
  try {
    assert.equal(await runMaterialSmoke({ chromium: process.execPath, env: {}, resultDir: join(root, "results"), timeoutMs: 2_000,
      platform: "linux", spawnProcess: fake.spawnProcess, stdout: { write() {} }, stderr: { write() {} } }), 1);
    const report = JSON.parse(readFileSync(join(root, "results", "smoke.json"), "utf8"));
    assert.equal(report.observedPageFlips, 0); assert.equal(report.passed, false);
    assert.equal(report.cleanup.passed, true);
  } finally { await fake.finish(); rmSync(root, { recursive: true, force: true }); }
});

test("smoke cleanup failure forces exit one and preserves the owned profile rather than deleting under a live tree", { timeout: 5_000 }, async () => {
  const { runMaterialSmoke } = await import("./test-browser-material-smoke.mjs");
  const root = mkdtempSync(join(tmpdir(), "vestus-smoke-test-")); const fake = boundary({ cleanupFailure: true });
  try {
    assert.equal(await runMaterialSmoke({ chromium: process.execPath, env: {}, resultDir: root, timeoutMs: 2_000,
      signalProcess() { const error = new Error("denied"); error.code = "EACCES"; throw error; },
      platform: "linux", spawnProcess: fake.spawnProcess, stdout: { write() {} }, stderr: { write() {} } }), 1);
    const report = JSON.parse(readFileSync(join(root, "smoke.json"), "utf8"));
    assert.equal(report.observedPageFlips, 60); assert.equal(report.cleanup.passed, false);
    assert.equal(report.cleanup.browserTreeExited, false); assert.equal(report.cleanup.ownedRootRemoved, false);
    assert.equal(existsSync(fake.profile), true);
  } finally { await fake.finish(); if (fake.profile) rmSync(join(fake.profile, ".."), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("smoke preflight writes failure report and never launches an invalid executable", { timeout: 5_000 }, async () => {
  const { runMaterialSmoke } = await import("./test-browser-material-smoke.mjs");
  const root = mkdtempSync(join(tmpdir(), "vestus-smoke-test-"));
  try {
    assert.equal(await runMaterialSmoke({ chromium: "relative-browser", resultDir: root,
      spawnProcess() { throw new Error("must not spawn"); }, stdout: { write() {} }, stderr: { write() {} } }), 1);
    assert.equal(JSON.parse(readFileSync(join(root, "smoke.json"), "utf8")).passed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("smoke timeout exits the real owned browser tree and removes its profile", { timeout: 5_000, skip: process.platform === "win32" }, async () => {
  const { runMaterialSmoke } = await import("./test-browser-material-smoke.mjs");
  const root = mkdtempSync(join(tmpdir(), "vestus-smoke-test-"));
  try {
    // Node is an existing controlled executable; its invalid Chromium flags cause readiness failure, not a real browser launch.
    assert.equal(await runMaterialSmoke({ chromium: process.execPath, env: process.env, resultDir: root, timeoutMs: 120,
      stdout: { write() {} }, stderr: { write() {} } }), 1);
    const report = JSON.parse(readFileSync(join(root, "smoke.json"), "utf8"));
    assert.equal(report.timedOut, true); assert.equal(report.cleanup.passed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("smoke CLI accepts executable override through aliases and rejects unknown flags", { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-smoke-alias-"));
  try {
    const alias = join(root, "smoke.mjs"); symlinkSync(fileURLToPath(new URL("./test-browser-material-smoke.mjs", import.meta.url)), alias);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [alias, "--unknown", "x"]); let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; }); child.once("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1); assert.match(result.stderr, /Usage: node scripts\/test-browser-material-smoke/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native ownership holds its Unix supervisor after command exit until verified group cleanup", { timeout: 5_000, skip: process.platform === "win32" }, async () => {
  const owner = spawnOwnedProcess(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.exit(0)"], { env: process.env });
  try {
    assert.equal((await owner.completion).code, 0);
    assert.equal(owner.closed, false);
    assert.equal(process.kill(owner.child.pid, 0), true);
    assert.equal(await owner.terminate(2_000), true);
    assert.throws(() => process.kill(-owner.child.pid, 0), { code: "ESRCH" });
  } finally { if (!owner.closed) await owner.terminate(2_000); }
});

test("Windows ownership uses a scoped Job wrapper, EOF stop and invocation-bound empty-job acknowledgement", { timeout: 5_000 }, async () => {
  for (const confirmed of [true, false]) {
    let invocation;
    const owner = spawnOwnedProcess("controlled.exe", ["a space", "quote\""], { env: { SystemRoot: "C:\\Windows" } }, {
      platform: "win32", spawnProcess(command, args, options) {
        invocation = { command, args, options };
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 7654;
        child.stdin = { end() {
          child.stderr.emit("data", "VESTUS_OWNED_JOB_EMPTY:forged\n");
          if (confirmed) child.stderr.emit("data", `VESTUS_OWNED_JOB_EMPTY:${options.env.VESTUS_OWNED_ACK}\n`);
          child.emit("close", 1, null);
        } };
        return child;
      },
    });
    assert.match(invocation.command, /powershell\.exe$/); assert.equal(invocation.options.detached, false);
    assert.equal(invocation.args.includes("-NoProfile"), true);
    assert.deepEqual(JSON.parse(invocation.options.env.VESTUS_OWNED_COMMAND), { command: "controlled.exe", args: ["a space", "quote\""] });
    if (confirmed) assert.equal(await owner.terminate(100), true);
    else await assert.rejects(owner.terminate(100), /Job exit was not confirmed/);
  }
});

// Public HTTP is the oracle; never inspect fixture state directly.
test("synthetic fixture serves a complete visible page and counts only nonce-bound page transitions", { timeout: 5_000 }, async () => {
  const { startMaterialFixture } = await import("./material-smoke-fixture.mjs");
  const fixture = await startMaterialFixture();
  try {
    const response = await fetch(fixture.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-next/);
    assert.match(html, /data-prev/);
    assert.match(html, /page-number/);
    const nonce = html.match(/const nonce = "([a-f0-9]+)"/)[1];
    const event = (body) => fetch(new URL("event", fixture.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await event({ nonce: "wrong", direction: "next", from: 1, to: 2, sequence: 1 })).status, 400);
    assert.equal((await event({ nonce, direction: "next", from: 1, to: 1, sequence: 1 })).status, 400);
    for (let i = 0; i < 30; i++) {
      assert.equal((await event({ nonce, direction: "next", from: 1, to: 2, sequence: i * 2 + 1 })).status, 204);
      assert.equal((await event({ nonce, direction: "prev", from: 2, to: 1, sequence: i * 2 + 2 })).status, 204);
    }
    assert.equal((await event({ nonce, direction: "prev", from: 2, to: 1, sequence: 60 })).status, 400);
    const counts = await (await fetch(fixture.statsUrl)).json();
    assert.equal(counts.observedPageFlips, 60);
    assert.equal(counts.next, 30);
    assert.equal(counts.previous, 30);
    assert.equal(counts.page, 1);
    assert.equal(counts.rejectedEvents, 3);
  } finally { await fixture.close(); }
});
