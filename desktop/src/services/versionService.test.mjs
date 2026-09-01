import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVersion,
  compareVersions,
  classifyAssetPlatform,
  filterCurrentSystemAssets,
  hasNewerVersion,
} from "./versionService.ts";

test("hasNewerVersion 只在两边版本号都已知时才判定可升级", () => {
  assert.equal(hasNewerVersion("0.2.2", "0.1.8"), true);
  assert.equal(hasNewerVersion("desktop-v0.2.2", "v0.1.8"), true);
  assert.equal(hasNewerVersion("0.1.8", "0.1.8"), false);
  assert.equal(hasNewerVersion("0.1.8", "0.2.2"), false);
  // 读不到本机版本（浏览器里的开发会话）时不能报「可升级」：没有比较的基准。
  assert.equal(hasNewerVersion("0.2.2", ""), false);
  assert.equal(hasNewerVersion("", "0.1.8"), false);
});

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

test("filterCurrentSystemAssets filters assets matching the current OS and architecture", () => {
  const allAssets = [
    {
      name: "Vestus-0.2.2-macos-aarch64.dmg",
      downloadUrl: "https://example.com/mac-arm64",
      size: 287212000,
      platform: "macOS (Apple Silicon M系列)",
    },
    {
      name: "Vestus-0.2.2-macos-x86_64.dmg",
      downloadUrl: "https://example.com/mac-x64",
      size: 305765000,
      platform: "macOS (Intel x86_64)",
    },
    {
      name: "Vestus-0.2.2-windows-x86_64.exe",
      downloadUrl: "https://example.com/win-x64",
      size: 149845000,
      platform: "Windows (x86_64)",
    },
    {
      name: "Vestus-0.2.2-linux-x86_64.AppImage",
      downloadUrl: "https://example.com/linux-appimage",
      size: 249454000,
      platform: "Linux (AppImage)",
    },
  ];

  // macOS Apple Silicon
  const macArm = filterCurrentSystemAssets(allAssets, {
    os: "macos",
    arch: "arm64",
    label: "macOS (Apple Silicon)",
  });
  assert.equal(macArm.length, 1);
  assert.equal(macArm[0].name, "Vestus-0.2.2-macos-aarch64.dmg");

  // macOS Intel
  const macIntel = filterCurrentSystemAssets(allAssets, {
    os: "macos",
    arch: "x64",
    label: "macOS (Intel)",
  });
  assert.equal(macIntel.length, 1);
  assert.equal(macIntel[0].name, "Vestus-0.2.2-macos-x86_64.dmg");

  // Windows
  const win = filterCurrentSystemAssets(allAssets, {
    os: "windows",
    arch: "x64",
    label: "Windows",
  });
  assert.equal(win.length, 1);
  assert.equal(win[0].name, "Vestus-0.2.2-windows-x86_64.exe");

  // Linux
  const linux = filterCurrentSystemAssets(allAssets, {
    os: "linux",
    arch: "x64",
    label: "Linux",
  });
  assert.equal(linux.length, 1);
  assert.equal(linux[0].name, "Vestus-0.2.2-linux-x86_64.AppImage");
});
