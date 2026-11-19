import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { runMaterialRegression } from "./test-browser-material.mjs";

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
