import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as preparation from "./prepare-chromium.mjs";
import * as archiveChecks from "./chromium-archive.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(128); bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(0x20b, 88); return bytes;
}
function macho(cpu, fat = false) {
  const bytes = Buffer.alloc(64);
  if (fat) { bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4); bytes.writeUInt32BE(0x01000007, 8); bytes.writeUInt32BE(0x0100000c, 28); }
  else { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); }
  return bytes;
}

test("macOS thin/fat Mach-O and Windows PE are checked without launching browser", () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-architecture-test-"));
  try {
    const mac = join(root, "mac"), win = join(root, "win"), app = join(mac, "Google Chrome for Testing.app");
    const macos = join(app, "Contents", "MacOS"), binary = join(macos, "Google Chrome for Testing");
    mkdirSync(macos, { recursive: true }); mkdirSync(win);
    writeFileSync(join(app, "Contents", "Info.plist"), "placeholder");
    const settings = { platform: "darwin", arch: "arm64", cwd: tmpdir(), execFileImpl: (command, args) => {
      assert.equal(command, "/usr/bin/plutil"); assert.deepEqual(args.slice(0, 5), ["-extract", "CFBundleShortVersionString", "raw", "-o", "-"]); return VERSION;
    } };
    for (const bytes of [macho(0x0100000c), macho(null, true)]) {
      writeFileSync(binary, bytes); assert.equal(preparation.validateCandidate(mac, { platform: "mac-arm64" }, settings), binary);
    }
    writeFileSync(binary, macho(0x01000007));
    assert.throws(() => preparation.validateCandidate(mac, { platform: "mac-arm64" }, settings), /architecture/i);
    mkdirSync(join(mac, "Other.app"));
    assert.throws(() => preparation.validateCandidate(mac, { platform: "mac-arm64" }, settings), /exactly one/i);
    writeFileSync(join(win, "chrome.exe"), pe());
    const windowsSettings = { platform: "win32", arch: "x64", cwd: tmpdir(), execFileImpl: (command, args) => {
      assert.equal(command, "powershell.exe"); assert.ok(args.includes("-NoProfile")); assert.match(args.at(-1), /FileVersionInfo.*FileVersion/); return VERSION;
    } };
    assert.equal(preparation.validateCandidate(win, { platform: "win64" }, windowsSettings), join(win, "chrome.exe"));
    writeFileSync(join(win, "chrome.exe"), pe(0xaa64));
    assert.throws(() => preparation.validateCandidate(win, { platform: "win64" }, windowsSettings), /architecture/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("archive redirects off the pinned storage path never reach extraction or replace resources", async (t) => {
  const { options, destination } = fixture(t);
  options.fetchImpl = async (url, settings) => url === metadataUrl ? metadataFetch()(url, settings) : new Response(null, { status: 307, headers: { location: "https://evil.example/chrome.zip" } });
  options.execFileImpl = () => assert.fail("must not extract rejected URL");
  await assert.rejects(preparation.prepareChromium(options), /URL/i);
  assert.equal(readFileSync(join(destination, "chrome"), "utf8"), "original");
});

test("importing Chromium preparation is inert (no download or installation)", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const childProcess = await import('node:child_process');
    const { syncBuiltinESMExports } = await import('node:module');
    childProcess.default.execFileSync = () => { throw new Error('unexpected command'); };
    syncBuiltinESMExports();
    globalThis.fetch = () => { throw new Error('unexpected network'); };
    const module = await import(${JSON.stringify(new URL("./prepare-chromium.mjs", import.meta.url).href)});
    if (typeof module.prepareChromium !== 'function') throw new Error('missing prepare seam');
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

const VERSION = "157.0.8103.78";
const metadataUrl = `https://googlechromelabs.github.io/chrome-for-testing/${VERSION}.json`;
const archiveUrl = (platform) => `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${platform}/chrome-${platform}.zip`;
const metadata = () => ({ version: VERSION, revision: "1717349", downloads: { chrome: [
  "linux64", "mac-arm64", "mac-x64", "win64",
].map((platform) => ({ platform, url: archiveUrl(platform) })) } });
const metadataFetch = (data = metadata()) => async (url, options) => {
  assert.equal(url, metadataUrl);
  assert.equal(options.redirect, "manual");
  return new Response(JSON.stringify(data), { status: 200 });
};

test("resolves only the four pinned official native release targets", async () => {
  for (const [platform, arch, expected] of [
    ["linux", "x64", "linux64"], ["win32", "x64", "win64"],
    ["darwin", "arm64", "mac-arm64"], ["darwin", "x64", "mac-x64"],
  ]) {
    const pin = await preparation.resolvePinnedDownload({ platform, arch, fetchImpl: metadataFetch() });
    assert.equal(pin.version, VERSION);
    assert.equal(pin.revision, "1717349");
    assert.equal(pin.platform, expected);
    assert.equal(pin.url, archiveUrl(expected));
  }
  for (const [platform, arch] of [["linux", "arm64"], ["win32", "arm64"], ["darwin", "ia32"], ["freebsd", "x64"]]) {
    await assert.rejects(preparation.resolvePinnedDownload({ platform, arch, fetchImpl: () => assert.fail("no network on unsupported target") }), /unsupported/i);
  }
});

test("rejects wrong version, revision, platform, URL and off-allowlist redirects", async () => {
  const bad = [
    { ...metadata(), version: "157.0.8103.77" },
    { ...metadata(), revision: "1717348" },
    { ...metadata(), downloads: { chrome: [{ platform: "mac-x64", url: archiveUrl("mac-x64") }] } },
    ...["http://storage.googleapis.com/chrome-for-testing-public/x.zip", "https://evil.example/chrome.zip", `${archiveUrl("mac-arm64")}?x=1`, archiveUrl("mac-x64"), archiveUrl("mac-arm64").replace(VERSION, "156.0.0.0")].map((url) => ({ ...metadata(), downloads: { chrome: [{ platform: "mac-arm64", url }] } })),
  ];
  for (const data of bad) {
    await assert.rejects(preparation.resolvePinnedDownload({ platform: "darwin", arch: "arm64", fetchImpl: metadataFetch(data) }), /version|revision|platform|URL/i);
  }
  let calls = 0;
  await assert.rejects(preparation.resolvePinnedDownload({ platform: "darwin", arch: "arm64", fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://evil.example/leak" } });
  } }), /URL|redirect/i);
  assert.equal(calls, 1);
});

// Tiny synthetic ZIPs, never downloaded or executed. Includes Unix symlink attributes.
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data = "x", mode = 0o100755, method = 0, localExtra = Buffer.alloc(0), centralExtra = Buffer.alloc(0) } of entries) {
    const nameBytes = Buffer.from(name), bytes = Buffer.from(data);
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10); record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE((mode << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, localExtra, compressed); central.push(record, nameBytes, centralExtra);
    offset += local.length + nameBytes.length + localExtra.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("ZIP preflight rejects traversal, wrong roots and escaping links before extraction", () => {
  const directory = mkdtempSync(join(tmpdir(), "vestus-zip-test-"));
  try {
    const path = join(directory, "test.zip");
    const check = (entries) => { writeFileSync(path, zip(entries)); return archiveChecks.validateZip(path, "chrome-linux64"); };
    assert.doesNotThrow(() => check([{ name: "chrome-linux64/chrome" }, { name: "chrome-linux64/lib/link", data: "../chrome", mode: 0o120777, method: 8 }]));
    for (const name of ["../outside", "/tmp/outside", "chrome-linux64/../outside", "chrome-linux64\\..\\outside", "chrome-linux64/C:/out", "chrome-win64/chrome", "chrome-linux64/x:stream", "chrome-linux64/x."]) {
      assert.throws(() => check([{ name }]), /ZIP|archive|root|path/i);
    }
    for (const data of ["../../outside", "/etc/passwd", "C:\\outside"]) {
      assert.throws(() => check([{ name: "chrome-linux64/link", data, mode: 0o120777 }]), /link|path/i);
    }
    assert.throws(() => check([{ name: "chrome-linux64/link", data: "chrome", mode: 0o120777 }, { name: "chrome-linux64/link/child" }]), /link/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("ZIP local and central extra fields both reject path overrides, ZIP64 and malformed framing", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vestus-zip-extra-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test.zip");
  const extra = (tag, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(4); header.writeUInt16LE(tag); header.writeUInt16LE(payload.length, 2);
    return Buffer.concat([header, payload]);
  };
  for (const field of ["localExtra", "centralExtra"]) {
    const check = (bytes) => { writeFileSync(path, zip([{ name: "chrome-linux64/chrome", [field]: bytes }])); archiveChecks.validateZip(path, "chrome-linux64"); };
    assert.doesNotThrow(() => check(extra(0x5455, Buffer.from([1, 0, 0, 0, 0]))));
    for (const bytes of [extra(0x7075, Buffer.from("../../escape")), extra(0x0001), Buffer.from([0x55]), Buffer.from([0x55, 0x54, 2, 0, 1])]) {
      assert.throws(() => check(bytes), /ZIP.*extra/i, field);
    }
  }
});

test("post-extraction validation rejects symlinks escaping the candidate tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "vestus-link-test-"));
  try {
    writeFileSync(join(directory, "chrome"), "x");
    symlinkSync("chrome", join(directory, "safe"));
    assert.doesNotThrow(() => archiveChecks.validateTree(directory));
    symlinkSync("../outside", join(directory, "unsafe"));
    assert.throws(() => archiveChecks.validateTree(directory), /link|escape/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function elf(machine = 62) {
  const bytes = Buffer.alloc(64); bytes.write("\x7fELF", "binary"); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(machine, 18); return bytes;
}
function nativeCommand(command, args, options) {
  assert.ok(options.cwd && !options.cwd.includes("chrome-linux64"));
  if (command === "unzip") {
    const directory = args[args.indexOf("-d") + 1];
    mkdirSync(join(directory, "chrome-linux64"));
    writeFileSync(join(directory, "chrome-linux64", "chrome"), elf());
    return "";
  }
  if (args[0] === "--version") {
    assert.deepEqual(args, ["--version"]);
    return "Google Chrome for Testing 157.0.8103.78\n";
  }
  assert.fail(`unexpected command ${command}`);
}

test("Windows Chromium extraction uses the compatible .NET ZipFile overload", () => {
  const source = readFileSync(new URL("./prepare-chromium.mjs", import.meta.url), "utf8");
  assert.match(source, /\[System\.IO\.Compression\.ZipFile\]::ExtractToDirectory\(\$\{psLiteral\(archive\)\}, \$\{psLiteral\(extractionRoot\)\}\)/);
  assert.doesNotMatch(source, /Expand-Archive/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "vestus-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, "resources", "chromium"), backupRoot = join(root, "backups");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "chrome"), "original"); writeFileSync(join(destination, ".gitkeep"), "keep");
  const archive = zip([{ name: "chrome-linux64/chrome", data: elf() }]);
  const fetchImpl = async (url, options) => url === metadataUrl ? metadataFetch()(url, options) : (assert.equal(url, archiveUrl("linux64")), new Response(archive));
  return { root, destination, backupRoot, options: { platform: "linux", arch: "x64", destination, backupRoot, fetchImpl, execFileImpl: nativeCommand } };
}

test("symlinked backup roots and ancestors into resources are rejected before archive operations", async (t) => {
  for (const ancestor of [false, true]) {
    const { root, destination, options } = fixture(t);
    const link = join(root, "backup-link");
    symlinkSync(join(root, "resources"), link, "dir");
    options.backupRoot = ancestor ? join(link, "nested-backups") : link;
    options.fetchImpl = (url, settings) => {
      if (url !== metadataUrl) assert.fail("must reject backup before archive download");
      return metadataFetch()(url, settings);
    };
    options.execFileImpl = () => assert.fail("must reject backup before commands");
    await assert.rejects(preparation.prepareChromium(options), /backups must stay outside|backup root must be a real directory/i);
    assert.equal(readFileSync(join(destination, "chrome"), "utf8"), "original");
    assert.equal(readdirSync(join(root, "resources")).some((name) => name.startsWith(".chromium-candidate-")), false);
  }
});

test("valid candidate replaces live only after checks, retains old backup and identity", async (t) => {
  const { destination, options } = fixture(t);
  const result = await preparation.prepareChromium(options);
  assert.deepEqual(readFileSync(join(destination, "chrome")), elf());
  assert.equal(readFileSync(join(destination, ".gitkeep"), "utf8"), "keep");
  assert.equal(readFileSync(join(result.backup, "chrome"), "utf8"), "original");
  const identity = JSON.parse(readFileSync(join(destination, "chromium-identity.json"), "utf8"));
  assert.equal(identity.version, VERSION); assert.equal(identity.revision, "1717349"); assert.equal(identity.platform, "linux64");
  assert.match(identity.executableSha256, /^[0-9a-f]{64}$/);
});

test("wrong version, extraction/candidate failure, rename failure and post-install failure leave original intact", async (t) => {
  for (const scenario of ["version", "candidate", "rename", "post-install"]) {
    const { destination, backupRoot, options } = fixture(t);
    if (scenario === "candidate") options.execFileImpl = () => { throw new Error("candidate extraction failure"); };
    if (scenario === "version") options.execFileImpl = (command, args, settings) => args[0] === "--version" ? "Google Chrome for Testing 156.0.0.0" : nativeCommand(command, args, settings);
    if (scenario === "rename") options.renameImpl = (from, to) => { if (to === destination && from.includes(".chromium-candidate-")) throw new Error("rename failure"); renameSync(from, to); };
    if (scenario === "post-install") options.execFileImpl = (command, args, settings) => { if (command === join(destination, "chrome")) throw new Error("post-install failure"); return nativeCommand(command, args, settings); };
    await assert.rejects(preparation.prepareChromium(options), /version|candidate|rename|post-install/i);
    assert.equal(readFileSync(join(destination, "chrome"), "utf8"), "original", scenario);
    assert.equal(readFileSync(join(destination, ".gitkeep"), "utf8"), "keep", scenario);
    assert.equal(readdirSync(backupRoot).some((name) => name.startsWith(".chromium-candidate-")), false);
  }
});

test("native validation rejects wrong architecture and exact-version mismatches", () => {
  const root = mkdtempSync(join(tmpdir(), "vestus-native-test-"));
  try {
    writeFileSync(join(root, "chrome"), elf(183));
    assert.throws(() => preparation.validateCandidate(root, { platform: "linux64" }, { platform: "linux", arch: "x64", cwd: tmpdir(), execFileImpl: nativeCommand }), /architecture/i);
    writeFileSync(join(root, "chrome"), elf());
    assert.throws(() => preparation.validateCandidate(root, { platform: "linux64" }, { platform: "linux", arch: "x64", cwd: tmpdir(), execFileImpl: () => "Google Chrome for Testing 157.0.8103.77" }), /version/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
