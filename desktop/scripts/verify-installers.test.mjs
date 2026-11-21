import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";
import { verifyInstallers } from "./verify-installers.mjs";

const script = fileURLToPath(new URL("./verify-installers.mjs", import.meta.url));
const fixture = () => mkdtempSync(join(realpathSync(tmpdir()), "vestus-installer-test-"));

function releaseFixture(label = "windows-x86_64") {
  const root = fixture();
  const tauri = join(root, "desktop", "src-tauri");
  mkdirSync(tauri, { recursive: true });
  writeFileSync(join(tauri, "tauri.conf.json"), JSON.stringify({ productName: "Fixture Product", version: "9.8.7", identifier: "org.example.fixture" }));
  writeFileSync(join(tauri, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.1"\n[[bin]]\nname = "fixture-bin"\npath = "src/main.rs"\n');
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, `Vestus-9.8.7-${label}.exe`), "installer fixture");
  return { root, assets, reports: join(root, "reports"), options: { root, platform: "win32", arch: "x64", env: {} } };
}

test("verified asset preflight refuses local installation before any command", async () => {
  const f = releaseFixture();
  try {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("installer fixture").digest("hex");
    writeFileSync(join(f.assets, "SHA256SUMS-windows-x86_64.txt"), `${hash}  Vestus-9.8.7-windows-x86_64.exe\n`);
    const result = await verifyInstallers("9.8.7", "windows-x86_64", f.assets, f.reports, { ...f.options, run: () => { assert.fail("local preflight must not run commands"); } });
    assert.equal(result.status, "failed");
    assert.ok(result.checks.some((check) => check.name === "assets" && check.status === "passed"));
    assert.match(result.errors.join(" "), /disposable/);
    assert.equal(result.metadata.productName, "Fixture Product");
    assert.equal(result.metadata.binary, "fixture-bin");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function put(path, contents) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, contents); }
function mach(cpu = 0x0100000c) { const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); return bytes; }
function sumAssets(f, label, extensions) {
  writeFileSync(join(f.assets, `SHA256SUMS-${label}.txt`), extensions.map((ext) => { const name = `Vestus-9.8.7-${label}.${ext}`; return `${createHash("sha256").update(readFileSync(join(f.assets, name))).digest("hex")}  ${name}\n`; }).join(""));
}
// 确定性模拟打包器的符号链接解引用：链接路径落成内容相同的真实文件。
function copyTreeDereferenced(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name), dst = join(to, entry.name);
    if (entry.isDirectory()) copyTreeDereferenced(src, dst);
    else if (entry.isSymbolicLink()) writeFileSync(dst, readFileSync(realpathSync(src)));
    else writeFileSync(dst, readFileSync(src));
  }
}

function macFixture({ dereferenceChromium = false } = {}) {
  const f = releaseFixture("macos-aarch64");
  rmSync(join(f.assets, "Vestus-9.8.7-macos-aarch64.exe"));
  put(join(f.assets, "Vestus-9.8.7-macos-aarch64.dmg"), "disk fixture");
  sumAssets(f, "macos-aarch64", ["dmg"]);
  const source = join(f.root, "desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Fixture Product.app");
  const plist = { CFBundleIdentifier: "org.example.fixture", CFBundleShortVersionString: "9.8.7", CFBundleVersion: "9.8.7", CFBundleName: "Fixture Product", CFBundleExecutable: "fixture-bin" };
  put(join(source, "Contents/Info.plist"), JSON.stringify(plist));
  put(join(source, "Contents/MacOS/fixture-bin"), mach());
  const chromium = join(f.root, "desktop/src-tauri/resources/chromium");
  put(join(chromium, "Browser Fixture.app/Contents/Info.plist"), JSON.stringify({ CFBundleExecutable: "Browser Fixture", CFBundleShortVersionString: "123.4.5.6" }));
  put(join(chromium, "Browser Fixture.app/Contents/MacOS/Browser Fixture"), mach());
  put(join(chromium, "runtime.pak"), "runtime material");
  put(join(chromium, "chromium-identity.json"), JSON.stringify({ version: "123.4.5.6", platform: "mac-arm64", executableSha256: createHash("sha256").update(mach()).digest("hex") }));
  f.source = source; f.chromium = chromium; f.commands = [];
  f.options = { root: f.root, platform: "darwin", arch: "arm64", env: {}, run: async (file, args, options) => {
    f.commands.push({ file, args, options });
    if (file === "/usr/bin/hdiutil" && args[0] === "attach") {
      const { cpSync } = await import("node:fs");
      const mount = args[args.indexOf("-mountpoint") + 1];
      cpSync(source, join(mount, "Fixture Product.app"), { recursive: true });
      if (dereferenceChromium) copyTreeDereferenced(chromium, join(mount, "Fixture Product.app/Contents/Resources/chromium"));
      else cpSync(chromium, join(mount, "Fixture Product.app/Contents/Resources/chromium"), { recursive: true });
      f.mount = mount;
      return { code: 0, stdout: JSON.stringify({ "system-entities": [{ "dev-entry": "/dev/disk99", "mount-point": mount }] }) };
    }
    if (file === "/usr/bin/plutil") return { code: 0, stdout: readFileSync(args.at(-1), "utf8") };
    if (file === "/usr/bin/codesign") return { code: 1, stderr: "code object is not signed at all" };
    if (file === "/usr/bin/hdiutil" && args[0] === "detach") return { code: 0, stdout: "detached" };
    assert.fail(`unexpected command ${file}`);
  } };
  return f;
}

test("macOS readonly verification checks dynamic bundle metadata, hashes and own detach", async () => {
  const f = macFixture();
  try {
    const result = await verifyInstallers("9.8.7", "macos-aarch64", f.assets, f.reports, f.options);
    assert.equal(result.status, "passed", result.errors.join(" "));
    assert.ok(result.checks.some((check) => check.name === "chromium-runtime" && check.status === "passed"));
    assert.ok(result.checks.some((check) => check.name === "codesign" && check.status === "unsigned"));
    const attach = f.commands.find((command) => command.args[0] === "attach");
    assert.ok(attach.args.includes("-readonly"));
    assert.ok(attach.args.includes("-plist"));
    assert.deepEqual(f.commands.find((command) => command.args[0] === "detach").args, ["detach", "/dev/disk99"]);
    assert.equal(result.cleanup.every((entry) => entry.status === "passed"), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("macOS verification tolerates framework symlinks dereferenced by the bundler", async () => {
  const f = macFixture({ dereferenceChromium: true });
  put(join(f.chromium, "Browser Fixture.app/Contents/Frameworks/Fix.framework/Versions/A/Fix"), mach());
  symlinkSync("Versions/A/Fix", join(f.chromium, "Browser Fixture.app/Contents/Frameworks/Fix.framework/Fix"));
  try {
    const result = await verifyInstallers("9.8.7", "macos-aarch64", f.assets, f.reports, f.options);
    assert.equal(result.status, "passed", result.errors.join(" "));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("macOS verification still rejects dereferenced framework content that changed", async () => {
  const f = macFixture({ dereferenceChromium: true });
  put(join(f.chromium, "Browser Fixture.app/Contents/Frameworks/Fix.framework/Versions/A/Fix"), mach());
  symlinkSync("Versions/A/Fix", join(f.chromium, "Browser Fixture.app/Contents/Frameworks/Fix.framework/Fix"));
  const base = f.options.run;
  f.options.run = async (file, args, options) => {
    const result = await base(file, args, options);
    if (file === "/usr/bin/hdiutil" && args[0] === "attach") {
      writeFileSync(join(f.mount, "Fixture Product.app/Contents/Resources/chromium/Browser Fixture.app/Contents/Frameworks/Fix.framework/Fix"), "tampered payload");
    }
    return result;
  };
  try {
    const result = await verifyInstallers("9.8.7", "macos-aarch64", f.assets, f.reports, f.options);
    assert.equal(result.status, "failed");
    assert.match(result.errors.join(" "), /Chromium runtime resource mismatch/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function elf(machine = 62) { const bytes = Buffer.alloc(128); bytes.set([127, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(machine, 18); return bytes; }
function linuxFixture() {
  const f = releaseFixture("linux-x86_64");
  rmSync(join(f.assets, "Vestus-9.8.7-linux-x86_64.exe"));
  put(join(f.assets, "Vestus-9.8.7-linux-x86_64.deb"), "deb fixture");
  put(join(f.assets, "Vestus-9.8.7-linux-x86_64.AppImage"), elf());
  sumAssets(f, "linux-x86_64", ["deb", "AppImage"]);
  put(join(f.root, "desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/fixture-bin"), elf());
  const chromium = join(f.root, "desktop/src-tauri/resources/chromium");
  put(join(chromium, "chrome"), elf()); put(join(chromium, "resources.pak"), "linux runtime material");
  put(join(chromium, "chromium-identity.json"), JSON.stringify({ version: "123.4.5.6", platform: "linux64", executableSha256: createHash("sha256").update(elf()).digest("hex") }));
  f.commands = []; f.trees = [];
  f.options = { root: f.root, platform: "linux", arch: "x64", env: { VESTUS_INSTALLER_TEST_DISPOSABLE: "1", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_TEMP: f.root }, run: async (file, args, options) => {
    f.commands.push({ file, args, options });
    if (file === "/usr/bin/dpkg-deb" && args[0] === "--field") return { code: 0, stdout: "Package: fixture-product\nVersion: 9.8.7\nArchitecture: amd64\n" };
    if (file === "/usr/bin/dpkg-deb" && args[0] === "--control") { put(join(args.at(-1), "control"), "Package: fixture-product\nVersion: 9.8.7\nArchitecture: amd64\n"); put(join(args.at(-1), "postinst"), "never execute this script"); return { code: 0, stdout: "" }; }
    let tree;
    if (file === "/usr/bin/dpkg-deb" && args[0] === "--extract") tree = args.at(-1);
    if (file.endsWith(".AppImage")) { assert.deepEqual(args, ["--appimage-extract"]); tree = join(options.cwd, "squashfs-root"); }
    if (tree) {
      const { cpSync } = await import("node:fs");
      put(join(tree, "usr/bin/fixture-bin"), elf());
      put(join(tree, "usr/share/applications/fixture-bin.desktop"), "[Desktop Entry]\nName=Fixture Product\nExec=fixture-bin\nType=Application\nIcon=fixture-bin\n");
      cpSync(chromium, join(tree, "usr/lib/Fixture Product/chromium"), { recursive: true });
      if (file.endsWith(".AppImage")) { put(join(tree, "fixture-bin.desktop"), readFileSync(join(tree, "usr/share/applications/fixture-bin.desktop"))); put(join(tree, "AppRun"), "runtime entrypoint, not executed"); put(join(tree, "usr/bin/fixture-bin"), Buffer.concat([elf(), Buffer.from("VESTUS-BUNDLE-TYPE: appimage")])); }
      chmodSync(join(tree, "usr/bin/fixture-bin"), 0o755);
      chmodSync(join(tree, "usr/lib/Fixture Product/chromium/chrome"), 0o755);
      if (file.endsWith(".AppImage")) chmodSync(join(tree, "AppRun"), 0o755);
      f.trees.push(tree);
      return { code: 0, stdout: "" };
    }
    assert.fail(`unexpected Linux command ${file}`);
  } };
  return f;
}

test("Linux verifies deb fields/control and AppImage extracted payload without maintainer scripts", async () => {
  const f = linuxFixture();
  try {
    const result = await verifyInstallers("9.8.7", "linux-x86_64", f.assets, f.reports, f.options);
    assert.equal(result.status, "passed", result.errors.join(" "));
    assert.equal(result.checks.filter((check) => check.name === "chromium-runtime").length, 2);
    assert.ok(result.checks.some((check) => check.name === "deb-metadata" && check.architecture === "amd64"));
    assert.ok(f.commands.every((command) => !command.args.includes("--install") && !command.file.endsWith("postinst")));
    assert.equal(result.cleanup.every((entry) => entry.status === "passed"), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function pe(machine = 0x8664) { const bytes = Buffer.alloc(256); bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, 152); return bytes; }
function windowsFixture() {
  const f = releaseFixture(); sumAssets(f, "windows-x86_64", ["exe"]);
  put(join(f.root, "desktop/src-tauri/target/x86_64-pc-windows-msvc/release/fixture-bin.exe"), pe());
  const chromium = join(f.root, "desktop/src-tauri/resources/chromium");
  put(join(chromium, "chrome.exe"), pe()); put(join(chromium, "resources.pak"), "Windows runtime material");
  put(join(chromium, "chromium-identity.json"), JSON.stringify({ version: "123.4.5.6", platform: "win64", executableSha256: createHash("sha256").update(pe()).digest("hex") }));
  f.commands = []; f.install = null;
  f.options = { root: f.root, platform: "win32", arch: "x64", env: { VESTUS_INSTALLER_TEST_DISPOSABLE: "1", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Windows", RUNNER_ARCH: "X64", RUNNER_TEMP: f.root }, run: async (file, args, options) => {
    assert.equal(file, "powershell.exe");
    assert.equal(args.at(-2), "-EncodedCommand");
    const text = Buffer.from(args.at(-1), "base64").toString("utf16le");
    f.commands.push({ file, args, options, text });
    if (text.includes("# installer:preflight")) return { code: 0, stdout: JSON.stringify({ installed: [], shortcuts: [], webview2: true }) };
    if (text.includes("# installer:install")) {
      const { cpSync } = await import("node:fs");
      f.install = /\$install = '([^']+)'/.exec(text)[1];
      put(join(f.install, "fixture-bin.exe"), pe());
      put(join(f.install, "uninstall.exe"), pe(0x14c));
      cpSync(chromium, join(f.install, "chromium"), { recursive: true });
      return { code: 0, stdout: JSON.stringify({ exited: true, exitCode: 0 }) };
    }
    if (text.includes("# installer:inspect")) return { code: 0, stdout: JSON.stringify({ installed: [{ displayName: "Fixture Product", displayVersion: "9.8.7", uninstallString: `"${join(f.install, "uninstall.exe")}"`, installLocation: f.install }], fileVersion: "9.8.7.0", productVersion: "9.8.7", productName: "Fixture Product", uninstallerSha256: createHash("sha256").update(pe(0x14c)).digest("hex") }) };
    if (text.includes("# installer:acl")) return { code: 0, stdout: JSON.stringify({ checked: 4, violations: [] }) };
    if (text.includes("# installer:uninstall")) { rmSync(f.install, { recursive: true }); return { code: 0, stdout: JSON.stringify({ exited: true, exitCode: 0, directoryAbsent: true, installed: [], shortcuts: [] }) }; }
    assert.fail(`unexpected PowerShell script ${text}`);
  } };
  return f;
}

test("Windows installs only in owned path with spaces, verifies PE/version/ACL and own uninstall", async () => {
  const f = windowsFixture();
  try {
    const result = await verifyInstallers("9.8.7", "windows-x86_64", f.assets, f.reports, f.options);
    assert.equal(result.status, "passed", result.errors.join(" "));
    assert.ok(f.install.includes(" "));
    const install = f.commands.find((command) => command.text.includes("# installer:install"));
    assert.match(install.text, /\/S \/D=/);
    const uninstall = f.commands.find((command) => command.text.includes("# installer:uninstall"));
    assert.match(uninstall.text, /\/S _\?=/);
    assert.ok(result.checks.some((check) => check.name === "sandbox-acl" && check.status === "passed"));
    assert.equal(result.sideEffects.installMode, "currentUser");
    assert.ok(f.commands.every((command) => !/Invoke-Expression|Stop-Process|Remove-ItemProperty|setx|RunAs|no-sandbox/.test(command.text)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("AppImage execution uses a fresh owned executable copy, never the collected asset", async () => {
  const f = linuxFixture();
  try {
    const result = await verifyInstallers("9.8.7", "linux-x86_64", f.assets, f.reports, f.options);
    assert.equal(result.status, "passed", result.errors.join(" "));
    const extraction = f.commands.find((command) => command.file.endsWith(".AppImage"));
    assert.notEqual(extraction.file, join(f.assets, "Vestus-9.8.7-linux-x86_64.AppImage"));
    assert.equal(readFileSync(join(f.assets, "Vestus-9.8.7-linux-x86_64.AppImage")).equals(elf()), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Windows permits only hash-verified uninstaller residue after registration removal", async () => {
  const f = windowsFixture(), run = f.options.run;
  try {
    f.options.run = async (...args) => {
      const text = Buffer.from(args[1].at(-1), "base64").toString("utf16le");
      if (text.includes("# installer:uninstall")) {
        const bytes = readFileSync(join(f.install, "uninstall.exe"));
        rmSync(f.install, { recursive: true });
        put(join(f.install, "uninstall.exe"), bytes);
        return { code: 0, stdout: JSON.stringify({ exited: true, exitCode: 0, directoryAbsent: false, installed: [], shortcuts: [] }) };
      }
      return run(...args);
    };
    const result = await verifyInstallers("9.8.7", "windows-x86_64", f.assets, f.reports, f.options);
    assert.equal(result.status, "passed", result.errors.join(" "));
    assert.ok(result.cleanup.some((entry) => entry.method === "verified-own-NSIS-uninstall"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("verification refuses changed input assets and never overwrites an existing report", async () => {
  const f = linuxFixture(), run = f.options.run;
  try {
    f.options.run = async (...args) => {
      const result = await run(...args);
      if (args[0].endsWith(".AppImage")) writeFileSync(join(f.assets, "Vestus-9.8.7-linux-x86_64.deb"), "changed during verification");
      return result;
    };
    const result = await verifyInstallers("9.8.7", "linux-x86_64", f.assets, f.reports, f.options);
    assert.equal(result.status, "failed");
    assert.match(result.errors.join(" "), /Asset SHA256 mismatch|assets changed/);
    const path = join(f.reports, "linux-x86_64.json"), saved = readFileSync(path, "utf8");
    const repeated = await verifyInstallers("9.8.7", "linux-x86_64", f.assets, f.reports, f.options);
    assert.equal(repeated.status, "failed");
    assert.equal(readFileSync(path, "utf8"), saved);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native validation failures still detach owned mounts and report failure", async () => {
  for (const failure of ["version", "architecture", "resources", "tool", "timeout", "cleanup"]) {
    const f = macFixture(), run = f.options.run;
    try {
      f.options.run = async (...args) => {
        if (failure === "tool" && args[0] === "/usr/bin/plutil") return { code: 2, stdout: "" };
        if (failure === "timeout" && args[0] === "/usr/bin/plutil") throw new Error("Command timed out");
        if (failure === "cleanup" && args[1][0] === "detach") return { code: 1, stdout: "" };
        const result = await run(...args);
        if (args[1][0] === "attach") {
          if (failure === "version") {
            const path = join(f.mount, "Fixture Product.app/Contents/Info.plist"), plist = JSON.parse(readFileSync(path, "utf8"));
            plist.CFBundleVersion = "0.0.1"; writeFileSync(path, JSON.stringify(plist));
          }
          if (failure === "architecture") writeFileSync(join(f.mount, "Fixture Product.app/Contents/MacOS/fixture-bin"), mach(0x01000007));
          if (failure === "resources") rmSync(join(f.mount, "Fixture Product.app/Contents/Resources/chromium/runtime.pak"));
        }
        return result;
      };
      const result = await verifyInstallers("9.8.7", "macos-aarch64", f.assets, f.reports, f.options);
      assert.equal(result.status, "failed", failure);
      assert.ok(result.errors.length, failure);
      assert.deepEqual(JSON.parse(readFileSync(join(f.reports, "macos-aarch64.json"), "utf8")), result);
      assert.ok(f.commands.some((command) => command.args[0] === "detach") || failure === "cleanup");
      for (const entry of result.cleanup.filter((entry) => entry.status === "failed" && entry.path)) rmSync(entry.path, { recursive: true, force: true });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("macOS packaging retains the signed app used as the final DMG comparison source", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"));
  assert.ok(config.bundle.targets.includes("app"));
  assert.ok(config.bundle.targets.includes("dmg"));
});

test("Linux payload with unchanged bytes but missing execute permission is rejected", async () => {
  for (const relativePath of ["usr/bin/fixture-bin", "usr/lib/Fixture Product/chromium/chrome", "AppRun"]) {
    const f = linuxFixture(), run = f.options.run;
    try {
      f.options.run = async (...args) => {
        const result = await run(...args);
        if (args[0].endsWith(".AppImage")) chmodSync(join(f.trees.at(-1), relativePath), 0o644);
        return result;
      };
      const result = await verifyInstallers("9.8.7", "linux-x86_64", f.assets, f.reports, f.options);
      assert.equal(result.status, "failed", relativePath);
      assert.match(result.errors.join(" "), /execut/i);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("Windows own uninstall shortcut residue cannot be reported as clean", async () => {
  const f = windowsFixture(), run = f.options.run;
  try {
    f.options.run = async (...args) => {
      const result = await run(...args);
      const text = Buffer.from(args[1].at(-1), "base64").toString("utf16le");
      if (text.includes("# installer:uninstall")) result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), shortcuts: ["owned shortcut residue"] });
      return result;
    };
    const result = await verifyInstallers("9.8.7", "windows-x86_64", f.assets, f.reports, f.options);
    assert.equal(result.status, "failed");
    assert.match(result.errors.join(" "), /shortcut/i);
    for (const entry of result.cleanup.filter((entry) => entry.status === "failed" && entry.path)) rmSync(entry.path, { recursive: true, force: true });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("CLI rejects missing assets with failed JSON and preserves a separate report", () => {
  const directory = fixture();
  try {
    const reports = join(directory, "reports");
    const result = spawnSync(process.execPath, [script, "9.8.7", "windows-x86_64", join(directory, "missing"), reports], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");
    assert.equal(report.label, "windows-x86_64");
    assert.deepEqual(JSON.parse(readFileSync(join(reports, "windows-x86_64.json"), "utf8")), report);
    assert.equal(report.notRun.gui, "not-run");
    assert.equal(report.notRun.login, "not-run");
    assert.equal(report.notRun.notarization, "not-run");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
