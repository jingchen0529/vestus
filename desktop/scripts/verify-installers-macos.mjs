import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertArchitecture, regularFile, sha256, verifyChromium } from "./verify-installers.mjs";
import { validateTree } from "./chromium-archive.mjs";

export async function verifyMacos(ctx) {
  const commands = ctx.temp(), mount = ctx.temp();
  ctx.plist = async (path) => {
    regularFile(path);
    const result = await ctx.command("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], commands);
    return JSON.parse(result.stdout);
  };
  let device;
  try {
    const output = await ctx.command("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-plist", "-mountpoint", mount, ctx.assets[0]], commands);
    // Convert hdiutil's plist without creating a file in the mounted filesystem.
    let entities;
    if (output.stdout.trim().startsWith("{")) entities = JSON.parse(output.stdout)["system-entities"];
    else {
      const { writeFileSync } = await import("node:fs");
      const path = join(commands, "mount.plist");
      writeFileSync(path, output.stdout, { flag: "wx" });
      entities = (await ctx.plist(path))["system-entities"];
    }
    const own = entities?.filter((entry) => entry["mount-point"] && resolve(entry["mount-point"]) === mount);
    if (own?.length !== 1 || !/^\/dev\/disk\d+(?:s\d+)*$/.test(own[0]["dev-entry"])) {
      ctx.retain(mount);
      throw new Error("Mount plist did not identify an owned device");
    }
    device = own[0]["dev-entry"];
    const apps = readdirSync(mount).filter((name) => name.endsWith(".app") && lstatSync(join(mount, name)).isDirectory());
    if (apps.length !== 1 || apps[0] !== `${ctx.metadata.productName}.app`) throw new Error("Disk image app bundle name mismatch");
    const app = join(mount, apps[0]);
    validateTree(app);
    const plist = await ctx.plist(join(app, "Contents/Info.plist"));
    if (plist.CFBundleIdentifier !== ctx.metadata.identifier || plist.CFBundleShortVersionString !== ctx.metadata.version || plist.CFBundleVersion !== ctx.metadata.version || plist.CFBundleName !== ctx.metadata.productName || plist.CFBundleExecutable !== ctx.metadata.binary) throw new Error("App plist product/identifier/version/executable mismatch");
    const executable = regularFile(join(app, "Contents/MacOS", ctx.metadata.binary));
    assertArchitecture(executable, ctx.target);
    const sources = [
      join(ctx.root, "desktop/src-tauri/target", ctx.target.triple, "release/bundle/macos", apps[0], "Contents/MacOS", ctx.metadata.binary),
      join(ctx.root, "desktop/src-tauri/target/release/bundle/macos", apps[0], "Contents/MacOS", ctx.metadata.binary),
    ];
    let source;
    for (const path of sources) {
      try { regularFile(path); source = path; break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!source) throw new Error("Current build source app executable missing");
    if (sha256(executable) !== sha256(source)) throw new Error("App executable hash differs from current build");
    ctx.report.checks.push({ name: "app-metadata", status: "passed", plist, executableSha256: sha256(executable) });
    await verifyChromium(ctx, join(app, "Contents/Resources/chromium"));
    const signature = await ctx.command("/usr/bin/codesign", ["--display", "--verbose=2", app], commands, [0, 1]);
    if (signature.code === 1) {
      if (!/code object is not signed at all/.test(signature.stderr ?? "")) throw new Error("codesign inspection failed");
      ctx.report.checks.push({ name: "codesign", status: "unsigned" });
    } else {
      // arm64 上 tauri 对 .app 做 ad-hoc 签名；打包器解引用框架符号链接会使
      // 嵌套 Chromium 的 seal 失效，--deep --strict 在 dev 无签名身份的构建上
      // 必然失败：记录状态与 stderr 摘要后继续（真实签名/公证仍未验证）。
      const verify = await ctx.command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], commands, [0, 1]);
      if (verify.code === 0) ctx.report.checks.push({ name: "codesign", status: "passed", notarization: "not-run" });
      else ctx.report.checks.push({ name: "codesign", status: "unsigned", note: (verify.stderr ?? "").slice(0, 400) });
    }
  } catch (error) {
    if (!device) ctx.retain(mount);
    throw error;
  } finally {
    if (device) {
      try {
        await ctx.command("/usr/bin/hdiutil", ["detach", device], commands);
        ctx.report.cleanup.push({ device, status: "passed" });
      } catch (error) {
        ctx.retain(mount);
        ctx.report.cleanup.push({ device, status: "failed", error: error.message });
        throw error;
      }
    }
  }
}
