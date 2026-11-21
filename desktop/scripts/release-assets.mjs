// 收集/校验已有安装包，不启动构建、不访问网络。
//   node desktop/scripts/release-assets.mjs collect <version> <label> <bundleDir> <outDir>
//   node desktop/scripts/release-assets.mjs verify <version> <assetsDir>
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseNotesPath } from "./check-release-notes.mjs";

const platforms = new Map([
  ["windows-x86_64", ["exe"]],
  ["macos-aarch64", ["dmg"]],
  ["macos-x86_64", ["dmg"]],
  ["linux-x86_64", ["deb", "AppImage"]],
]);

const installerExtensions = new Set([".exe", ".dmg", ".deb", ".appimage", ".msi", ".rpm", ".pkg"]);

function walk(directory, rejectSymlinks = false) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && rejectSymlinks) throw new Error(`产物不能是符号链接：${path}`);
    if (stat.isDirectory()) files.push(...walk(path, rejectSymlinks));
    else if (stat.isFile()) files.push(path);
    else if (!stat.isSymbolicLink()) throw new Error(`产物必须是普通文件或目录：${path}`);
  }
  return files;
}

function assetName(version, label, extension) {
  return `Vestus-${version}-${label}.${extension}`;
}

function checksum(contents, name) {
  return `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`;
}

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function checkedDirectory(path, allowMissing = false) {
  const directory = resolve(path);
  const paths = [];
  for (let current = directory; ; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) break;
  }
  for (const current of paths.reverse()) {
    const stat = statIfPresent(current);
    if (!stat && allowMissing) continue;
    if (!stat) throw new Error(`目录不存在：${current}`);
    if (stat.isSymbolicLink()) throw new Error(`目录不能是符号链接：${current}`);
    if (!stat.isDirectory()) throw new Error(`必须是普通目录：${current}`);
  }
  return directory;
}

function writeNewOutputs(directory, outputs) {
  checkedDirectory(directory, true);
  // Preflight every destination before creating even the first output. Exclusive
  // creation also refuses conflicts introduced after preflight; only files this
  // invocation created may be removed if a subsequent write fails.
  for (const { name } of outputs) {
    if (statIfPresent(join(directory, name))) throw new Error(`输出文件已存在：${name}`);
  }
  mkdirSync(directory, { recursive: true });
  const created = [];
  try {
    for (const { name, contents } of outputs) {
      const path = join(directory, name);
      const fd = openSync(path, "wx");
      try {
        created.push({ path, stat: fstatSync(fd) });
        writeFileSync(fd, contents);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    for (const { path, stat } of created.reverse()) {
      const current = statIfPresent(path);
      if (current?.dev === stat.dev && current?.ino === stat.ino) unlinkSync(path);
    }
    throw error;
  }
}

export function collectReleaseAssets(version, label, bundleDir, outDir) {
  releaseNotesPath(version);
  const extensions = platforms.get(label);
  if (!extensions) throw new Error(`不支持的平台：${label}`);
  const inputs = walk(checkedDirectory(bundleDir));
  for (const path of inputs) {
    if (installerExtensions.has(extname(path).toLowerCase()) && !extensions.includes(extname(path).slice(1))) {
      throw new Error(`额外安装包：${path}`);
    }
  }
  const outputs = [];
  for (const extension of extensions) {
    const matches = inputs.filter((path) => extname(path) === `.${extension}`);
    if (matches.length !== 1) throw new Error(`安装包 .${extension} 必须恰好有一个`);
    outputs.push({ name: assetName(version, label, extension), contents: readFileSync(matches[0]) });
  }
  outputs.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const manifest = outputs.map(({ name, contents }) => checksum(contents, name)).join("");
  outputs.push({ name: `SHA256SUMS-${label}.txt`, contents: manifest });
  writeNewOutputs(resolve(outDir), outputs);
  return outputs.map(({ name }) => name);
}

function manifestHashes(source, expected, manifestName) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hashes = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\s/\\:]+)$/.exec(line);
    if (!match) throw new Error(`清单格式无效（SHA256 两空格 basename）：${manifestName}`);
    const [, hash, name] = match;
    if (!expected.has(name)) throw new Error(`清单含未知条目：${manifestName} / ${name}`);
    if (hashes.has(name)) throw new Error(`清单含重复条目：${manifestName} / ${name}`);
    hashes.set(name, hash);
  }
  if (hashes.size !== expected.size) throw new Error(`清单未完整覆盖安装包：${manifestName}`);
  return hashes;
}

export function verifyReleaseAssets(version, assetsDir) {
  releaseNotesPath(version);
  const directory = checkedDirectory(assetsDir);
  const expectedFiles = new Set(["SHA256SUMS.txt"]);
  for (const [label, extensions] of platforms) {
    expectedFiles.add(`SHA256SUMS-${label}.txt`);
    for (const extension of extensions) expectedFiles.add(assetName(version, label, extension));
  }
  for (const path of walk(directory, true)) {
    const name = path.slice(directory.length + 1);
    if (!expectedFiles.has(name)) {
      throw new Error(`未知发布产物（发布文件必须在根目录）：${name}`);
    }
  }
  const entries = [];
  for (const [label, extensions] of platforms) {
    const manifestName = `SHA256SUMS-${label}.txt`;
    const expected = new Set(extensions.map((extension) => assetName(version, label, extension)));
    const hashes = manifestHashes(readFileSync(join(directory, manifestName), "utf8"), expected, manifestName);
    for (const extension of extensions) {
      const name = assetName(version, label, extension);
      const line = checksum(readFileSync(join(directory, name)), name);
      if (hashes.get(name) !== line.slice(0, 64)) throw new Error(`SHA256 不一致：${name}`);
      entries.push({ name, line });
    }
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const contents = entries.map(({ line }) => line).join("");
  const merged = join(directory, "SHA256SUMS.txt");
  if (statIfPresent(merged)) {
    if (readFileSync(merged, "utf8") !== contents) throw new Error("已有合并清单与安装包不一致");
  } else {
    writeNewOutputs(directory, [{ name: "SHA256SUMS.txt", contents }]);
  }
  return "SHA256SUMS.txt";
}

function run() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "collect" && args.length === 4) {
    collectReleaseAssets(...args);
    console.log("release assets: collected");
  } else if (command === "verify" && args.length === 2) {
    verifyReleaseAssets(...args);
    console.log("release assets: verified");
  } else {
    throw new Error("用法：node desktop/scripts/release-assets.mjs collect <version> <label> <bundleDir> <outDir> | verify <version> <assetsDir>");
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
