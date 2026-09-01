import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVersion,
  compareVersions,
  classifyAssetPlatform,
} from "./versionService.ts";

test("normalizeVersion strips desktop- and v prefixes", () => {
  assert.equal(normalizeVersion("desktop-v0.2.2"), "0.2.2");
  assert.equal(normalizeVersion("v0.1.8"), "0.1.8");
  assert.equal(normalizeVersion("0.1.8"), "0.1.8");
  assert.equal(normalizeVersion("  v1.0.0  "), "1.0.0");
});

test("compareVersions compares semver versions correctly", () => {
  assert.equal(compareVersions("0.2.2", "0.1.8"), 1);
  assert.equal(compareVersions("0.1.8", "0.2.2"), -1);
  assert.equal(compareVersions("0.1.8", "0.1.8"), 0);
  assert.equal(compareVersions("desktop-v0.2.2", "v0.1.8"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("classifyAssetPlatform categorizes operating systems properly", () => {
  assert.equal(
    classifyAssetPlatform("Vestus-0.2.2-macos-aarch64.dmg"),
    "macOS (Apple Silicon M系列)"
  );
  assert.equal(
    classifyAssetPlatform("Vestus-0.2.2-macos-x86_64.dmg"),
    "macOS (Intel x86_64)"
  );
  assert.equal(
    classifyAssetPlatform("Vestus-0.2.2-windows-x86_64.exe"),
    "Windows (x86_64)"
  );
  assert.equal(
    classifyAssetPlatform("Vestus-0.2.2-linux-x86_64.AppImage"),
    "Linux (AppImage)"
  );
  assert.equal(
    classifyAssetPlatform("Vestus-0.2.2-linux-x86_64.deb"),
    "Linux (Debian / Ubuntu)"
  );
});
