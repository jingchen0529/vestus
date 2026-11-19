// Fixed Chrome for Testing Stable pin, prepared natively on the four release runners.
// Layout remains compatible with browser.rs and chromium-resource.mjs.
import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, copyFileSync, cpSync, createReadStream, createWriteStream,
  existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumResourceDir } from "./chromium-resource.mjs";
import { validateTree, validateZip } from "./chromium-archive.mjs";

export const CHROMIUM_VERSION = "157.0.8103.78";
export const CHROMIUM_REVISION = "1717349";
const METADATA_URL = `https://googlechromelabs.github.io/chrome-for-testing/${CHROMIUM_VERSION}.json`;
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = {
  "linux-x64": "linux64",
  "win32-x64": "win64",
  "darwin-arm64": "mac-arm64",
  "darwin-x64": "mac-x64",
};

function assertOfficialUrl(url, expected) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.href !== expected || parsed.username || parsed.password) {
    throw new Error(`Rejected non-pinned official URL: ${url}`);
  }
}

async function officialResponse(url, fetchImpl, timeout) {
  // No ambient redirects: every hop must still be this exact official pin/path.
  let current = url;
  for (let hops = 0; hops <= 3; hops++) {
    assertOfficialUrl(current, url);
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(timeout) });
    if (response.url) assertOfficialUrl(response.url, url);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect has no URL");
      current = new URL(location, current).href;
      assertOfficialUrl(current, url);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Official download returned HTTP ${response.status}`);
    }
    return response;
  }
  throw new Error("Too many official URL redirects");
}

export async function resolvePinnedDownload({ platform = process.platform, arch = process.arch, fetchImpl = fetch } = {}) {
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported Chromium release target: ${platform}/${arch}`);
  const response = await officialResponse(METADATA_URL, fetchImpl, 30_000);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Official metadata is too large");
    chunks.push(chunk);
  }
  const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (metadata.version !== CHROMIUM_VERSION) throw new Error("CfT metadata version mismatch");
  if (metadata.revision !== CHROMIUM_REVISION) throw new Error("CfT metadata revision mismatch");
  const downloads = metadata.downloads?.chrome;
  const matches = Array.isArray(downloads) ? downloads.filter((entry) => entry.platform === target) : [];
  if (matches.length !== 1) throw new Error("CfT metadata platform missing or duplicated");
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROMIUM_VERSION}/${target}/chrome-${target}.zip`;
  assertOfficialUrl(matches[0].url, url);
  return { version: CHROMIUM_VERSION, revision: CHROMIUM_REVISION, platform: target, url, root: `chrome-${target}` };
}

function assertArchitecture(executable, platform, arch) {
  const fd = openSync(executable, "r");
  try {
    const header = Buffer.alloc(4096), length = readSync(fd, header, 0, header.length, 0);
    let valid = false;
    if (platform === "linux") valid = length >= 64 && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62 && arch === "x64";
    if (platform === "win32" && length >= 64 && header.toString("ascii", 0, 2) === "MZ") {
      const offset = header.readUInt32LE(0x3c), pe = Buffer.alloc(26);
      if (offset >= 64 && readSync(fd, pe, 0, pe.length, offset) === pe.length) valid = pe.readUInt32LE(0) === 0x00004550 && pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b && arch === "x64";
    }
    if (platform === "darwin" && length >= 32) {
      const cpu = arch === "arm64" ? 0x0100000c : 0x01000007, magic = header.readUInt32BE(0);
      if (magic === 0xcffaedfe) valid = header.readUInt32LE(4) === cpu;
      if (magic === 0xfeedfacf) valid = header.readUInt32BE(4) === cpu;
      if ([0xcafebabe, 0xcafebabf].includes(magic)) {
        const count = header.readUInt32BE(4), stride = magic === 0xcafebabf ? 32 : 20;
        if (count > 0 && count <= 32 && 8 + count * stride <= length) {
          for (let i = 0; i < count; i++) if (header.readUInt32BE(8 + i * stride) === cpu) valid = true;
        }
      }
    }
    if (!valid) throw new Error(`Chromium binary architecture mismatch: ${platform}/${arch}`);
  } finally { closeSync(fd); }
}

const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

export function validateCandidate(directory, pin, { platform = process.platform, arch = process.arch, cwd = desktopRoot, execFileImpl = execFileSync } = {}) {
  validateTree(directory);
  const mac = platform === "darwin", appName = "Google Chrome for Testing.app";
  if (targets[`${platform}-${arch}`] !== pin.platform) throw new Error("Candidate platform mismatch");
  if (mac) {
    const apps = readdirSync(directory).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1 || apps[0] !== appName) throw new Error("Candidate must contain exactly one expected macOS app");
  }
  const executable = join(directory, ...(mac ? [appName, "Contents", "MacOS", "Google Chrome for Testing"] : [platform === "win32" ? "chrome.exe" : "chrome"]));
  if (!existsSync(executable) || !lstatSync(executable).isFile()) throw new Error("Candidate Chromium executable missing or not a regular file");
  assertArchitecture(executable, platform, arch);
  if (platform !== "win32") {
    for (const path of [executable, ...(platform === "linux" ? ["chrome_crashpad_handler", "chrome_sandbox", "xdg-mime", "xdg-settings"].map((name) => join(directory, name)) : [])]) if (existsSync(path)) chmodSync(path, 0o755);
  }
  const options = { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, shell: false };
  let version;
  if (mac) version = execFileImpl("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(directory, appName, "Contents", "Info.plist")], options).trim();
  else if (platform === "win32") version = execFileImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; [System.Diagnostics.FileVersionInfo]::GetVersionInfo(${psLiteral(executable)}).FileVersion`], options).trim();
  else {
    const output = execFileImpl(executable, ["--version"], options).trim();
    version = /^(?:Google Chrome for Testing|Google Chrome|Chromium) (\d+\.\d+\.\d+\.\d+)$/.exec(output)?.[1];
  }
  if (version !== CHROMIUM_VERSION) throw new Error(`Chromium native version mismatch: ${version ?? "unknown"}`);
  return executable;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertOutside(parent, path) {
  const rel = relative(resolve(parent), resolve(path));
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))) throw new Error("Chromium backups must stay outside packaging resources");
}

// Injectable native operations let tests exercise all failure paths without network or browsers.
// The production entry accepts no update/version/platform command-line inputs.
export async function prepareChromium({ platform = process.platform, arch = process.arch, fetchImpl = fetch, execFileImpl = execFileSync, renameImpl = renameSync, destination = chromiumResourceDir, backupRoot = join(desktopRoot, ".cache", "chromium-backups") } = {}) {
  const pin = await resolvePinnedDownload({ platform, arch, fetchImpl });
  destination = resolve(destination); backupRoot = resolve(backupRoot);
  assertOutside(dirname(destination), backupRoot);
  mkdirSync(dirname(destination), { recursive: true }); mkdirSync(backupRoot, { recursive: true });
  if (!lstatSync(backupRoot).isDirectory() || lstatSync(backupRoot).isSymbolicLink()) throw new Error("Chromium backup root must be a real directory");
  const resourceParent = realpathSync(dirname(destination));
  backupRoot = realpathSync(backupRoot);
  assertOutside(resourceParent, backupRoot);
  if (statSync(resourceParent).dev !== statSync(backupRoot).dev) throw new Error("Chromium backup and resource must share a filesystem");
  if (existsSync(destination) && (!lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink())) throw new Error("Live Chromium resource must be a real directory");
  // Archive, extraction and command cwd are separate fresh empty roots. Never run
  // an interpreter/build tool in an extracted tree or read ambient browser caches.
  const downloadRoot = mkdtempSync(join(tmpdir(), "vestus-cft-download-"));
  const extractionRoot = mkdtempSync(join(tmpdir(), "vestus-cft-extract-"));
  const commandRoot = mkdtempSync(join(tmpdir(), "vestus-cft-commands-"));
  const candidate = mkdtempSync(join(backupRoot, ".chromium-candidate-"));
  const backup = join(backupRoot, `chromium-${Date.now()}-${randomUUID()}`);
  let movedOld = false, installed = false;
  try {
    const archive = join(downloadRoot, `${pin.root}.zip`);
    const response = await officialResponse(pin.url, fetchImpl, 10 * 60_000);
    if (!response.body) throw new Error("Official archive response has no body");
    const sizeLimit = 1024 * 1024 * 1024;
    const declaredSize = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > sizeLimit) {
      await response.body.cancel();
      throw new Error("Official Chromium archive content-length exceeds size limit");
    }
    let downloaded = 0;
    async function* limitedArchive() {
      for await (const chunk of Readable.fromWeb(response.body)) {
        downloaded += chunk.length;
        if (downloaded > sizeLimit) throw new Error("Official Chromium archive exceeds size limit");
        yield chunk;
      }
      if (declaredSize && downloaded !== declaredSize) throw new Error("Official Chromium archive content-length mismatch");
    }
    await pipeline(limitedArchive(), createWriteStream(archive, { flags: "wx" }));
    validateZip(archive, pin.root);
    const commandOptions = { cwd: commandRoot, stdio: "pipe", timeout: 5 * 60_000, shell: false };
    if (platform === "darwin") execFileImpl("/usr/bin/ditto", ["-x", "-k", archive, extractionRoot], commandOptions);
    else if (platform === "linux") execFileImpl("unzip", ["-q", archive, "-d", extractionRoot], commandOptions);
    else execFileImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psLiteral(archive)}, ${psLiteral(extractionRoot)})`], commandOptions);
    const roots = readdirSync(extractionRoot);
    if (roots.length !== 1 || roots[0] !== pin.root) throw new Error("Extracted archive root mismatch");
    const source = join(extractionRoot, pin.root);
    validateTree(source);
    validateCandidate(source, pin, { platform, arch, cwd: commandRoot, execFileImpl });
    if (platform === "darwin") execFileImpl("/usr/bin/ditto", [join(source, "Google Chrome for Testing.app"), join(candidate, "Google Chrome for Testing.app")], commandOptions);
    else cpSync(source, candidate, { recursive: true, verbatimSymlinks: true });
    const gitkeep = join(destination, ".gitkeep");
    if (existsSync(gitkeep)) {
      if (!lstatSync(gitkeep).isFile()) throw new Error("Resource .gitkeep must be a regular file");
      copyFileSync(gitkeep, join(candidate, ".gitkeep"));
    }
    const settings = { platform, arch, cwd: commandRoot, execFileImpl };
    const candidateExecutable = validateCandidate(candidate, pin, settings);
    const identity = { version: pin.version, revision: pin.revision, platform: pin.platform, executableSha256: await sha256(candidateExecutable) };
    writeFileSync(join(candidate, "chromium-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
    if (existsSync(destination)) { renameImpl(destination, backup); movedOld = true; }
    renameImpl(candidate, destination); installed = true;
    const executable = validateCandidate(destination, pin, settings);
    if (await sha256(executable) !== identity.executableSha256 || JSON.stringify(JSON.parse(readFileSync(join(destination, "chromium-identity.json"), "utf8"))) !== JSON.stringify(identity)) throw new Error("Installed Chromium identity mismatch");
    return { executable, identity, backup: movedOld ? backup : null };
  } catch (error) {
    try {
      if (installed) renameImpl(destination, join(backupRoot, `failed-chromium-${randomUUID()}`));
      if (movedOld) renameImpl(backup, destination);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Chromium installation/rollback failed; original retained at ${backup}`);
    }
    throw error;
  } finally {
    // Only disposable staging trees are removed. Old binary backups are retained.
    for (const directory of [candidate, downloadRoot, extractionRoot, commandRoot]) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { console.warn(`Chromium staging cleanup failed (${directory}): ${error.message}`); }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareChromium();
  console.log(`chromium ready: ${result.executable}`);
  console.log(JSON.stringify(result.identity));
  if (result.backup) console.log(`previous chromium retained: ${result.backup}`);
}
