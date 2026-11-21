import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { runMaterialRegression } from "./test-browser-material.mjs";

test("material runner rejects a cached JSON even when cargo prints a passing test", { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-material-runner-"));
  try {
    const resultPath = join(root, "cached.json");
    writeFileSync(resultPath, JSON.stringify({ variant: "A", rounds: 30, samples: Array(31).fill({}) }));
    const status = await runMaterialRegression({
      platform: "linux",
      env: { ...environment(root), VESTUS_MATERIAL_RESULT: resultPath },
      resultDir: join(root, "results"),
      spawnProcess: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("test cdp::control_tests::material_selection_30_flip_regression ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;\n"));
          child.emit("close", 0, null);
        });
        return child;
      },
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.equal(status, 1);
    assert.equal(JSON.parse(readFileSync(join(root, "results", "A.runner.json"), "utf8")).passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("material timeout closes the owned cargo tree and retains the caller profile", { timeout: 5_000, skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-material-runner-"));
  let cargo;
  let emergency;
  try {
    const status = await runMaterialRegression({
      env: environment(root),
      resultDir: join(root, "results"),
      timeoutMs: 150,
      spawnProcess: (command, args, options) => {
        if (command === "/bin/ps") return spawn(command, args, options);
        cargo = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});setInterval(()=>{},1000)"], { ...options, detached: true });
        emergency = setTimeout(() => { try { process.kill(-cargo.pid, "SIGKILL"); } catch {} }, 1_500);
        return cargo;
      },
      stdout: { write() {} }, stderr: { write() {} },
    });
    assert.equal(status, 1);
    const report = JSON.parse(readFileSync(join(root, "results", "A.runner.json"), "utf8"));
    assert.equal(report.timedOut, true);
    assert.equal(report.cleanup.cargoTreeExited, true);
    assert.equal(report.cleanup.passed, true);
    assert.equal(report.cleanup.callerProfileUntouched, true);
    assert.equal(existsSync(root), true);
    assert.throws(() => process.kill(-cargo.pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(emergency);
    if (cargo?.exitCode === null && cargo?.signalCode === null) process.kill(-cargo.pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("material CLI executes through a filesystem alias rather than silently returning success", { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-material-alias-"));
  try {
    const alias = join(root, "runner.mjs");
    symlinkSync(fileURLToPath(new URL("./test-browser-material.mjs", import.meta.url)), alias);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VESTUS_MATERIAL_")));
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [alias], { env });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      child.once("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /VESTUS_MATERIAL_PROFILE must be set/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function environment(profile, variant = "A") {
  return {
    VESTUS_MATERIAL_PROFILE: profile,
    VESTUS_MATERIAL_URL: "https://platform.example.test/",
    VESTUS_MATERIAL_NEXT_SELECTOR: "[data-next]",
    VESTUS_MATERIAL_PREV_SELECTOR: "[data-prev]",
    VESTUS_MATERIAL_VARIANT: variant,
  };
}

test("material runner fails before cargo when page configuration is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-material-runner-"));
  try {
    let invoked = false;
    const status = await runMaterialRegression({
      env: {},
      resultDir: join(root, "results"),
      spawnProcess: () => {
        invoked = true;
        throw new Error("cargo must not run");
      },
      stdout: { write() {} },
      stderr: { write() {} },
    }).catch(() => 1);
    assert.equal(status, 1);
    assert.equal(invoked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("material runner requires the named one-test passing result", async () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-material-runner-"));
  try {
    const output = "running 1 test\ntest cdp::control_tests::material_selection_30_flip_regression ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 333 filtered out; finished in 0.01s\n";
    let invocation;
    const status = await runMaterialRegression({
      platform: "linux",
      env: environment(root),
      resultDir: join(root, "results"),
      spawnProcess: (...args) => {
        invocation = args;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          writeFileSync(invocation[2].env.VESTUS_MATERIAL_RESULT, `${JSON.stringify({
            variant: "A",
            rounds: 30,
            samples: Array.from({ length: 31 }, () => ({})),
          })}\n`);
          child.stdout.emit("data", Buffer.from(output));
          child.emit("close", 0, null);
        });
        return child;
      },
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.equal(status, 0);
    assert.equal(invocation[0], "cargo");
    assert.equal(invocation[1][3], "cdp::control_tests::material_selection_30_flip_regression");
    assert.equal(invocation[2].env.VESTUS_MATERIAL_VARIANT, "A");
    assert.equal(isAbsolute(invocation[2].env.VESTUS_MATERIAL_RESULT), true);
    const report = JSON.parse(readFileSync(join(root, "results", "A.runner.json"), "utf8"));
    assert.equal(report.passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
