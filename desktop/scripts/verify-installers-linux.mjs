import { chmodSync, copyFileSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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
  if (!inside(root, resolved) || !stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("Linux payload executable permissions or target invalid");
}

async function payload(ctx, root, format) {
  validateTree(root);
  const executable = regularFile(join(root, "usr/bin", ctx.metadata.binary));
  requireExecutable(executable, root);
  assertArchitecture(executable, ctx.target);
  if (sha256(executable) !== sha256(currentBinary(ctx))) throw new Error("Linux app executable hash differs from current build");
  const desktop = checkDesktop(join(root, "usr/share/applications", `${ctx.metadata.binary}.desktop`), ctx.metadata);
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
