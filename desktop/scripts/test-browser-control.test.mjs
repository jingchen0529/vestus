import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runControlTest } from "./test-browser-control.mjs";

const passing = "running 1 test\ntest cdp::control_tests::target_commands_work_against_a_real_browser ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 42 filtered out; finished in 0.01s\n";

async function exercise(t, { output = passing, code = 0, signal = null, error, throws = false, chrome = process.execPath } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vestus-control-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultDir = join(root, "results");
  let stdout = "";
  let stderr = "";
  let invocation;
  const status = await runControlTest({
    env: { VESTUS_CONTROL_CHROMIUM: chrome },
    resultDir,
    stdout: { write: (data) => { stdout += data.toString(); } },
    stderr: { write: (data) => { stderr += data.toString(); } },
    spawnProcess: (...args) => {
      invocation = args;
      if (throws) throw error;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(output.slice(0, 17)));
        child.stdout.emit("data", Buffer.from(output.slice(17)));
        child.stderr.emit("data", Buffer.from("cargo diagnostics\n"));
        if (error) child.emit("error", error);
        child.emit("close", code, signal);
      });
      return child;
    },
  });
  return {
    status, stdout, stderr, invocation,
    log: readFileSync(join(resultDir, "control.log"), "utf8"),
    result: JSON.parse(readFileSync(join(resultDir, "control.json"), "utf8")),
  };
}

test("missing cargo error followed by close cannot pass and is recorded and printed", async (t) => {
  const error = Object.assign(new Error("spawn cargo ENOENT"), { code: "ENOENT" });
  const run = await exercise(t, { error, code: 0 });
  assert.equal(run.status, 1);
  assert.equal(run.result.passed, false);
  assert.match(run.log, /spawn cargo ENOENT/);
  assert.match(run.stderr, /spawn cargo ENOENT/);
  assert.match(run.result.error, /spawn cargo ENOENT/);
});

test("one passing exact real-browser test succeeds with locked serial ignored-test selection", async (t) => {
  const run = await exercise(t);
  assert.equal(run.status, 0);
  assert.equal(run.result.passed, true);
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.signal, null);
  assert.equal(run.invocation[0], "cargo");
  assert.deepEqual(run.invocation[1], [
    "test", "--locked", "--lib",
    "cdp::control_tests::target_commands_work_against_a_real_browser",
    "--", "--ignored", "--exact", "--nocapture", "--test-threads=1",
  ]);
  assert.equal(run.invocation[2].cwd, fileURLToPath(new URL("../src-tauri", import.meta.url)));
  assert.equal(run.invocation[2].env.VESTUS_CONTROL_CHROMIUM, process.execPath);
  assert.deepEqual(run.invocation[2].stdio, ["ignore", "pipe", "pipe"]);
  assert.ok(run.stdout.includes(passing));
  assert.match(run.stderr, /cargo diagnostics/);
  assert.ok(run.log.includes(passing));
  assert.match(run.log, /cargo diagnostics/);
  assert.equal(run.result.stdout, passing);
  assert.equal(run.result.stderr, "cargo diagnostics\n");
});

for (const [name, options] of [
  ["zero tests selected", { output: "running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 42 filtered out;\n" }],
  ["all ignored", { output: "running 1 test\ntest result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 42 filtered out;\n" }],
  ["unexpected extra passing test", { output: passing.replace("1 passed", "2 passed") }],
  ["passing plus ignored", { output: passing.replace("0 ignored", "1 ignored") }],
  ["no test summary", { output: "cargo diagnostics only\n" }],
  ["nonzero cargo exit", { code: 101 }],
  ["cargo terminated by signal", { code: 0, signal: "SIGTERM" }],
  ["null exit code", { code: null }],
]) {
  test(`${name} refuses a false success`, async (t) => {
    const run = await exercise(t, options);
    assert.equal(run.status, 1);
    assert.equal(run.result.passed, false);
    assert.equal(run.result.exitCode, options.code === undefined ? 0 : options.code);
    assert.equal(run.result.signal, options.signal ?? null);
  });
}

test("synchronous spawn errors are also recorded as failure", async (t) => {
  const run = await exercise(t, { throws: true, error: new Error("cargo unavailable") });
  assert.equal(run.status, 1);
  assert.match(run.result.error, /cargo unavailable/);
  assert.match(run.log, /cargo unavailable/);
});

for (const chrome of ["relative/chrome", join(tmpdir(), "vestus-control-missing-chrome"), tmpdir()]) {
  test(`invalid Chromium path ${JSON.stringify(chrome)} never invokes cargo`, async (t) => {
    const run = await exercise(t, { chrome });
    assert.equal(run.status, 1);
    assert.equal(run.invocation, undefined);
    assert.match(run.stderr, /existing absolute executable path/);
  });
}

test("import is inert and CLI guard resolves temporary directory aliases", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vestus-control-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "desktop", "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of ["test-browser-control.mjs", "chromium-resource.mjs"]) {
    copyFileSync(new URL(`./${name}`, import.meta.url), join(scripts, name));
  }
  const script = join(scripts, "test-browser-control.mjs");
  const options = {
    cwd: tmpdir(), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, VESTUS_CONTROL_CHROMIUM: "relative/chrome" },
  };
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`], options);
  assert.ifError(imported.error);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  const cli = spawnSync(process.execPath, [script], options);
  assert.ifError(cli.error);
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /existing absolute executable path/);
  assert.equal(JSON.parse(readFileSync(join(root, "desktop/test-results/browser-control/control.json"), "utf8")).passed, false);
});

test("release gates real control on every platform between core and unchanged persistence policy", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  const control = workflow.match(/      - name: Verify real Chromium control\n([\s\S]*?)(?=      - name:)/)?.[1];
  assert.ok(control, "missing real Chromium control gate");
  assert.ok(workflow.indexOf("Test Rust core") < workflow.indexOf("Verify real Chromium control"));
  assert.ok(workflow.indexOf("Verify real Chromium control") < workflow.indexOf("Verify real Chromium persistence"));
  assert.doesNotMatch(control, /continue-on-error|\n\s+if:|\|\| true/);
  assert.match(control, /timeout-minutes: 15/);
  assert.match(control, /shell: bash/);
  assert.match(control, /working-directory: desktop/);
  assert.match(control, /if \[ "\$RUNNER_OS" = "Linux" \]; then\n\s+xvfb-run -a npm run test:control\n\s+else\n\s+npm run test:control/);
  assert.match(workflow, /- name: Upload control test results\n\s+if: always\(\)\n\s+uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: browser-control-\$\{\{ matrix\.label \}\}\n\s+path: desktop\/test-results\/browser-control\//);
  assert.match(workflow, /continue-on-error: \$\{\{ runner\.os == 'Windows' \}\}/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["test:control"], "node scripts/test-browser-control.mjs");
  assert.ok(pkg.scripts.test.includes("scripts/*.test.mjs"));
});
