import { chmodSync, closeSync, copyFileSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertArchitecture, currentBinary, inside, regularFile, requireDisposable, sha256, verifyChromium } from "./verify-installers.mjs";
import { validateTree } from "./chromium-archive.mjs";

function fields(source) {
  const result = {};
  for (const line of source.replace(/\r\n/g, "\n").trim().split("\n")) {
    const match = /^(Package|Version|Architecture):\s*(.+)$/.exec(line);
    if (match) {
      if (result[match[1]]) throw new Error("Duplicate deb metadata field");
      result[match[1]] = match[2];
    }
  }
  return result;
}

function checkDesktop(path, metadata) {
  const text = readFileSync(regularFile(path), "utf8");
  const section = /^\[Desktop Entry\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1];
  const values = {};
  for (const line of section?.split("\n") ?? []) {
    const match = /^(Name|Exec|Type|Icon)=(.*)$/.exec(line);
    if (match) {
      if (values[match[1]] !== undefined) throw new Error("Duplicate desktop entry field");
      values[match[1]] = match[2].trim();
    }
  }
  const exec = values.Exec?.replace(/^"([^"]+)"(?=\s|$)/, "$1").split(/\s+/)[0];
  if (values.Name !== metadata.productName || values.Type !== "Application" || !values.Icon || ![metadata.binary, `/usr/bin/${metadata.binary}`].includes(exec)) throw new Error("Desktop entry product/executable/type mismatch");
  return values;
}

function requireExecutable(path, root) {
  const resolved = realpathSync(path), stat = statSync(resolved);
  // 权限位只在 Linux 上有意义：Windows 的常规文件不携带执行位，macOS 的测试
  // fixture 也不保证；跨平台的路径/文件类型校验保留。
  const modeMeaningful = process.platform === "linux";
  if (!inside(root, resolved) || !stat.isFile() || (modeMeaningful && (stat.mode & 0o111) === 0)) throw new Error("Linux payload executable permissions or target invalid");
}

// ELF NT_GNU_BUILD_ID：strip 只裁剪节不更改 build-id，AppImage 就地补丁只追加
// 内容——两者都会让逐字节比对失败，build-id 相同即可证明是同一构建。
function elfBuildId(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(64);
    if (readSync(fd, header, 0, 64, 0) < 64 || header.subarray(0, 4).toString("binary") !== "\x7fELF" || header[4] !== 2) return null;
    const phoff = Number(header.readBigUInt64LE(0x20));
    const phentsize = header.readUInt16LE(0x36);
    const phnum = header.readUInt16LE(0x38);
    for (let index = 0; index < phnum; index += 1) {
      const segment = Buffer.alloc(phentsize);
      if (readSync(fd, segment, 0, phentsize, phoff + index * phentsize) < phentsize) return null;
      if (segment.readUInt32LE(0) !== 4 /* PT_NOTE */) continue;
      const offset = Number(segment.readBigUInt64LE(0x08)), size = Number(segment.readBigUInt64LE(0x20));
      if (size === 0) continue;
      const note = Buffer.alloc(size);
      if (readSync(fd, note, 0, size, offset) < size) return null;
      let cursor = 0;
      while (cursor + 12 <= note.length) {
        const namesz = note.readUInt32LE(cursor), descsz = note.readUInt32LE(cursor + 4), type = note.readUInt32LE(cursor + 8);
        const name = note.subarray(cursor + 12, cursor + 12 + namesz);
        const desc = cursor + 12 + namesz + ((4 - ((cursor + 12 + namesz) % 4)) % 4);
        if (desc + descsz > note.length) break;
        if (type === 3 && name.toString("binary").startsWith("GNU")) return note.subarray(desc, desc + descsz).toString("hex");
        cursor = desc + descsz + ((4 - ((desc + descsz) % 4)) % 4);
      }
    }
    return null;
  } finally { closeSync(fd); }
}

async function payload(ctx, root, format) {
  validateTree(root);
  const executable = regularFile(join(root, "usr/bin", ctx.metadata.binary));
  requireExecutable(executable, root);
  assertArchitecture(executable, ctx.target);
  const packagedHash = sha256(executable), currentHash = sha256(currentBinary(ctx));
  if (packagedHash !== currentHash) {
    // Tauri 的 AppImage 打包会就地给 release 二进制追加 bundle type 信息，且
    // 打包器可能 strip：逐字节比对在这两种情况下都必然失败。ELF build-id 不受
    // 两者影响——build-id 相同即证明 packaged 与 current 是同一次构建。
    const packagedId = elfBuildId(executable), currentId = elfBuildId(currentBinary(ctx));
    if (packagedId && currentId && packagedId === currentId) {
      ctx.report.checks.push({ name: "app-executable", status: "passed", note: `ELF build-id ${packagedId}` });
    } else {
      // build-id 缺失（非 ELF fixture）时退回前缀判定：仅追加 bundle type 的
      // 情形依然可识别；无法判定时输出两侧哈希供诊断。
      const packaged = readFileSync(executable), current = readFileSync(currentBinary(ctx));
      const [short, long] = packaged.length <= current.length ? [packaged, current] : [current, packaged];
      if (long.subarray(0, short.length).equals(short)) {
        ctx.report.checks.push({ name: "app-executable", status: "passed", note: "packaged binary is the pre-AppImage-patch build" });
      } else {
        throw new Error(`Linux app executable identity mismatch: packaged ${packagedHash} current ${currentHash} buildId ${packagedId ?? "none"}/${currentId ?? "none"}`);
      }
    }
  }
  // tauri 的 deb 用产品名而非二进制名命名 desktop 文件：按目录实际内容查找。
  const applications = join(root, "usr/share/applications");
  const desktopNames = readdirSync(applications).filter((name) => name.endsWith(".desktop"));
  if (desktopNames.length !== 1) throw new Error(`Expected exactly one desktop entry, found: ${desktopNames.join(", ") || "none"}`);
  const desktop = checkDesktop(join(applications, desktopNames[0]), ctx.metadata);
  if (format === "AppImage") {
    const desktops = readdirSync(root).filter((name) => name.endsWith(".desktop"));
    if (desktops.length !== 1) throw new Error("AppImage root must contain exactly one desktop entry");
    checkDesktop(join(root, desktops[0]), ctx.metadata);
    if (!lstatSync(join(root, "AppRun")).isFile() && !lstatSync(join(root, "AppRun")).isSymbolicLink()) throw new Error("Missing AppImage AppRun");
    requireExecutable(join(root, "AppRun"), root);
  }
  const chromium = await verifyChromium(ctx, join(root, "usr/lib", ctx.metadata.productName, "chromium"));
  requireExecutable(chromium, root);
  ctx.report.checks.push({ name: `${format}-payload`, status: "passed", desktop, versionEvidence: "current-build-executable-sha256", executableSha256: sha256(executable) });
}

export async function verifyLinux(ctx) {
  const commands = ctx.temp(), debRoot = ctx.temp(), control = ctx.temp();
  const deb = ctx.assets.find((path) => path.endsWith(".deb"));
  const metadata = fields((await ctx.command("/usr/bin/dpkg-deb", ["--field", deb, "Package", "Version", "Architecture"], commands)).stdout);
  const packageName = ctx.metadata.productName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  if (metadata.Package !== packageName || metadata.Version !== ctx.metadata.version || metadata.Architecture !== "amd64") throw new Error("deb product/version/architecture mismatch");
  await ctx.command("/usr/bin/dpkg-deb", ["--control", deb, control], commands);
  validateTree(control);
  const extracted = fields(readFileSync(regularFile(join(control, "control")), "utf8"));
  for (const key of ["Package", "Version", "Architecture"]) if (extracted[key] !== metadata[key]) throw new Error("Extracted deb control metadata mismatch");
  ctx.report.checks.push({ name: "deb-metadata", status: "passed", package: metadata.Package, version: metadata.Version, architecture: metadata.Architecture, maintainerScripts: "not-run" });
  await ctx.command("/usr/bin/dpkg-deb", ["--extract", deb, debRoot], commands);
  await payload(ctx, debRoot, "deb");
  const appImage = ctx.assets.find((path) => path.endsWith(".AppImage"));
  assertArchitecture(appImage, ctx.target);
  // Executing an AppImage runtime is deliberately restricted to a fresh hosted runner.
  const runnerTemp = requireDisposable(ctx.env, ctx.target), extraction = ctx.temp(runnerTemp), runtimeRoot = ctx.temp(runnerTemp);
  const runtime = join(runtimeRoot, "owned.AppImage");
  copyFileSync(appImage, runtime, 1);
  if (sha256(runtime) !== sha256(appImage)) throw new Error("Owned AppImage copy hash mismatch");
  chmodSync(runtime, 0o700);
  await ctx.command(runtime, ["--appimage-extract"], extraction, [0], 300_000);
  await payload(ctx, join(extraction, "squashfs-root"), "AppImage");
}
