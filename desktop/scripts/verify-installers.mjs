// Verify collected installers without building, downloading or launching the application.
// node desktop/scripts/verify-installers.mjs <version> <label> <assetsDir> <reportDir>
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { validateTree } from "./chromium-archive.mjs";
import { verifyWindows } from "./verify-installers-windows.mjs";
import { verifyLinux } from "./verify-installers-linux.mjs";
import { verifyMacos } from "./verify-installers-macos.mjs";
import { releaseNotesPath } from "./check-release-notes.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const targets = {
  "windows-x86_64": { platform: "win32", arch: "x64", extensions: ["exe"], triple: "x86_64-pc-windows-msvc" },
  "macos-aarch64": { platform: "darwin", arch: "arm64", extensions: ["dmg"], triple: "aarch64-apple-darwin" },
  "macos-x86_64": { platform: "darwin", arch: "x64", extensions: ["dmg"], triple: "x86_64-apple-darwin" },
  "linux-x86_64": { platform: "linux", arch: "x64", extensions: ["deb", "AppImage"], triple: "x86_64-unknown-linux-gnu" },
};

export const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const inside = (root, path) => {
  const rel = relative(resolve(root), resolve(path));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

export function checkedDirectory(path, missing = false) {
  const directory = resolve(path);
  const ancestors = [];
  for (let current = directory; ; current = dirname(current)) {
    ancestors.push(current);
    if (current === dirname(current)) break;
  }
  for (const current of ancestors.reverse()) {
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (missing && error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Directory must not be a symlink: ${current}`);
  }
  return directory;
}

export function runCommand(file, args, options) {
  return new Promise((resolveResult, reject) => {
    execFile(file, args, { ...options, encoding: "utf8", shell: false, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) reject(new Error(`Command failed or timed out: ${file}`));
      else resolveResult({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function assetPreflight(version, label, assetsDir, target) {
  const directory = checkedDirectory(assetsDir);
  const names = target.extensions.map((ext) => `Vestus-${version}-${label}.${ext}`);
  const manifest = `SHA256SUMS-${label}.txt`;
  const expected = [...names, manifest].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected)) throw new Error("Exact collected asset list mismatch (missing or additional assets)");
  for (const name of expected) if (!lstatSync(join(directory, name)).isFile()) throw new Error("Assets must be regular files, not symlinks");
  const lines = readFileSync(join(directory, manifest), "utf8").replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hashes = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\s/\\:]+)$/.exec(line);
    if (!match || !names.includes(match[2]) || hashes.has(match[2])) throw new Error("Invalid asset checksum manifest");
    hashes.set(match[2], match[1]);
  }
  if (hashes.size !== names.length) throw new Error("Incomplete asset checksum manifest");
  for (const name of names) if (sha256(join(directory, name)) !== hashes.get(name)) throw new Error(`Asset SHA256 mismatch: ${name}`);
  return names.map((name) => join(directory, name));
}

function metadataFor(version, root) {
  const tauri = join(root, "desktop", "src-tauri");
  const config = JSON.parse(readFileSync(join(tauri, "tauri.conf.json"), "utf8"));
  if (config.version !== version) throw new Error("Stamped Tauri version mismatch");
  for (const key of ["productName", "identifier"]) if (typeof config[key] !== "string" || !config[key] || /[\x00-\x1f/\\]/.test(config[key])) throw new Error(`Invalid Tauri ${key}`);
  const cargo = readFileSync(join(tauri, "Cargo.toml"), "utf8");
  const bins = [...cargo.matchAll(/^\[\[bin\]\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)].map((match) => /^name\s*=\s*"([\w.-]+)"\s*$/m.exec(match[1])?.[1]);
  if (bins.length !== 1 || !bins[0]) throw new Error("Cargo must define exactly one named application binary");
  return { productName: config.productName, identifier: config.identifier, version: config.version, binary: bins[0] };
}

export function requireDisposable(env, target) {
  if (env.VESTUS_INSTALLER_TEST_DISPOSABLE !== "1" || env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || env.RUNNER_OS !== ({ win32: "Windows", linux: "Linux", darwin: "macOS" })[target.platform] || env.RUNNER_ARCH !== ({ x64: "X64", arm64: "ARM64" })[target.arch] || !env.RUNNER_TEMP || !isAbsolute(env.RUNNER_TEMP)) throw new Error("Native installer execution requires explicit disposable GitHub-hosted runner consent and RUNNER_TEMP");
  return checkedDirectory(env.RUNNER_TEMP);
}

export function assertArchitecture(path, target) {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(4096), length = readSync(fd, bytes, 0, bytes.length, 0);
    let valid = false;
    if (target.platform === "linux") valid = length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62;
    if (target.platform === "win32" && length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
      const offset = bytes.readUInt32LE(60), pe = Buffer.alloc(26);
      valid = offset >= 64 && readSync(fd, pe, 0, 26, offset) === 26 && pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b;
    }
    if (target.platform === "darwin" && length >= 32) {
      const cpu = target.arch === "arm64" ? 0x0100000c : 0x01000007, magic = bytes.readUInt32BE(0);
      if (magic === 0xcffaedfe) valid = bytes.readUInt32LE(4) === cpu;
      if (magic === 0xfeedfacf) valid = bytes.readUInt32BE(4) === cpu;
      if ([0xcafebabe, 0xcafebabf].includes(magic)) {
        const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabf ? 32 : 20;
        if (count > 0 && count <= 32 && 8 + count * stride <= length) {
          for (let i = 0; i < count; i++) if (bytes.readUInt32BE(8 + i * stride) === cpu) valid = true;
        }
      }
    }
    if (!valid) throw new Error(`Binary architecture mismatch: ${target.platform}/${target.arch}`);
  } finally { closeSync(fd); }
}

export function currentBinary(ctx) {
  const name = `${ctx.metadata.binary}${ctx.target.platform === "win32" ? ".exe" : ""}`;
  const candidates = [join(ctx.root, "desktop/src-tauri/target", ctx.target.triple, "release", name), join(ctx.root, "desktop/src-tauri/target/release", name)];
  for (const path of candidates) {
    try { return regularFile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("Current build source executable missing");
}

export function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Expected regular file: ${path}`);
  return path;
}

function treeIdentity(root) {
  validateTree(root);
  const entries = {};
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path), key = relative(root, path).split(sep).join("/");
      if (name === ".gitkeep") continue;
      if (stat.isDirectory()) { entries[key] = "directory"; walk(path); }
      else if (stat.isSymbolicLink()) entries[key] = `link:${readlinkSync(path)}`;
      else entries[key] = sha256(path);
    }
  };
  walk(root);
  return entries;
}

export async function verifyChromium(ctx, installed) {
  const source = join(ctx.root, "desktop/src-tauri/resources/chromium");
  const sourceTree = treeIdentity(source), installedTree = treeIdentity(installed);
  if (JSON.stringify(sourceTree) !== JSON.stringify(installedTree)) throw new Error("Chromium runtime resource hash/tree mismatch");
  const identity = JSON.parse(readFileSync(regularFile(join(source, "chromium-identity.json")), "utf8"));
  const expectedPlatform = ({ "win32-x64": "win64", "linux-x64": "linux64", "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64" })[`${ctx.target.platform}-${ctx.target.arch}`];
  if (identity.platform !== expectedPlatform || !/^\d+\.\d+\.\d+\.\d+$/.test(identity.version) || !/^[a-f0-9]{64}$/.test(identity.executableSha256)) throw new Error("Invalid source Chromium identity");
  let executable;
  if (ctx.target.platform === "darwin") {
    const apps = readdirSync(source).filter((name) => name.endsWith(".app") && lstatSync(join(source, name)).isDirectory());
    if (apps.length !== 1) throw new Error("Expected exactly one Chromium app");
    const plist = await ctx.plist(join(source, apps[0], "Contents/Info.plist"));
    if (plist.CFBundleShortVersionString !== identity.version || typeof plist.CFBundleExecutable !== "string" || /[/\\\x00-\x1f]/.test(plist.CFBundleExecutable)) throw new Error("Chromium plist identity mismatch");
    const bundledPlist = await ctx.plist(join(installed, apps[0], "Contents/Info.plist"));
    if (JSON.stringify(plist) !== JSON.stringify(bundledPlist)) throw new Error("Chromium bundle plist mismatch");
    executable = join(installed, apps[0], "Contents/MacOS", plist.CFBundleExecutable);
  } else executable = join(installed, ctx.target.platform === "win32" ? "chrome.exe" : "chrome");
  regularFile(executable); assertArchitecture(executable, ctx.target);
  if (sha256(executable) !== identity.executableSha256) throw new Error("Source/bundled Chromium executable identity mismatch");
  ctx.report.checks.push({ name: "chromium-runtime", status: "passed", identity, files: Object.keys(installedTree).length });
  return executable;
}

function context(options, root, target, metadata, assets, report) {
  const owned = [], remove = options.remove ?? rmSync;
  return {
    root, target, metadata, assets, report, env: options.env ?? process.env,
    temp(parent = realpathSync(tmpdir())) {
      const path = mkdtempSync(join(checkedDirectory(parent), "vestus-installer-"));
      owned.push({ path, stat: lstatSync(path), retain: false });
      return path;
    },
    retain(path) { const entry = owned.find((entry) => entry.path === path); if (entry) entry.retain = true; },
    async command(file, args, cwd, allowed = [0], timeout = 120_000) {
      const result = await (options.run ?? runCommand)(file, args, { cwd, timeout, shell: false, encoding: "utf8" });
      if (!result || !allowed.includes(result.code)) throw new Error(`Command failed: ${file} (exit ${result?.code ?? "unknown"})`);
      return result;
    },
    async cleanup() {
      for (const entry of owned.reverse()) {
        try {
          if (entry.retain) throw new Error("Owned tree retained because native cleanup was not confirmed");
          const stat = lstatSync(entry.path);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino) throw new Error("Owned temp identity changed; refusing cleanup");
          await remove(entry.path, { recursive: true, force: false });
          report.cleanup.push({ path: entry.path, status: "passed" });
        } catch (error) { report.cleanup.push({ path: entry.path, status: "failed", error: error.message }); report.errors.push(`Cleanup failed: ${error.message}`); }
      }
    },
  };
}

export async function verifyInstallers(version, label, assetsDir, reportDir, options = {}) {
  const report = { version, label, status: "failed", checks: [], errors: [], cleanup: [], notRun: { gui: "not-run", login: "not-run", notarization: "not-run" } };
  let reportPath, ctx;
  try {
    releaseNotesPath(version);
    const target = targets[label];
    if (!target) throw new Error("Unsupported installer label");
    const output = checkedDirectory(reportDir, true);
    if (inside(assetsDir, output) || inside(output, assetsDir)) throw new Error("Reports must be separate from assets");
    mkdirSync(output, { recursive: true });
    const reserved = join(output, `${label}.json`);
    // Reserve exclusively before preflight; never replace a report from another run.
    writeFileSync(reserved, "", { flag: "wx" });
    reportPath = reserved;
    const assets = assetPreflight(version, label, assetsDir, target);
    report.checks.push({ name: "assets", status: "passed", files: assets.map((path) => path.slice(resolve(assetsDir).length + 1)) });
    const root = options.root ?? repositoryRoot;
    report.metadata = metadataFor(version, root);
    if ((options.platform ?? process.platform) !== target.platform || (options.arch ?? process.arch) !== target.arch) throw new Error("Native runner platform/architecture mismatch");
    if (target.platform === "win32") requireDisposable(options.env ?? process.env, target);
    ctx = context(options, root, target, report.metadata, assets, report);
    if (target.platform === "darwin") await verifyMacos(ctx);
    else if (target.platform === "linux") await verifyLinux(ctx);
    else await verifyWindows(ctx);
    assetPreflight(version, label, assetsDir, target);
  } catch (error) {
    report.errors.push(error.message);
  } finally {
    if (ctx) await ctx.cleanup();
  }
  if (!report.errors.length) report.status = "passed";
  if (reportPath) {
    try { writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
    catch (error) { report.errors.push(`Report write failed: ${error.message}`); report.status = "failed"; }
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const result = args.length === 4
    ? await verifyInstallers(...args)
    : { status: "failed", errors: ["Usage: verify-installers.mjs <version> <label> <assetsDir> <reportDir>"] };
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "passed" ? 0 : 1;
}
