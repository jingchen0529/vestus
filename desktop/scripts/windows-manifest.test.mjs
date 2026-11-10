import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Run the dependency-free build helper against target triples, not this host OS.
test("Windows MSVC tests get the common-controls manifest without dropping non-Windows tests", () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-windows-manifest-"));
  try {
    const executable = join(root, process.platform === "win32" ? "manifest-tests.exe" : "manifest-tests");
    const source = fileURLToPath(new URL("../src-tauri/windows_manifest.rs", import.meta.url));
    const compiled = spawnSync("rustc", ["--edition=2021", "--test", source, "-o", executable], { encoding: "utf8", timeout: 60_000 });
    assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
    const tested = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    assert.match(tested.stdout, /3 passed; 0 failed/);
    const build = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
    assert.match(build, /windows_manifest::link_arguments/);
    assert.match(build, /CARGO_CFG_TARGET_OS/);
    assert.match(build, /CARGO_CFG_TARGET_ENV/);
    assert.doesNotMatch(build, /cfg!\(test\)/, "build scripts are not compiled with cfg(test) for cargo test");
    assert.match(build, /WindowsAttributes::new_without_app_manifest\(\)/,
      "the MSVC linker manifest must replace, not duplicate, tauri-winres' manifest resource");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
