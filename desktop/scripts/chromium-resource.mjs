// resources/chromium/ 下那个「browser.rs 会真正拿去启动」的可执行文件在哪。
//
// 布局必须和 browser.rs:resolve_chromium_executable() 一致：Windows 是
// chrome.exe，Linux 是 chrome，macOS 是 <浏览器>.app/Contents/MacOS/<可执行文件>
// ——最后这个名字随 Playwright 版本变（Chromium.app → "Google Chrome for
// Testing.app"），所以这里和 Rust 侧一样是扫描，不写死名字。
//
// 两个调用方：prepare-chromium.mjs 铺完之后拿它做完工校验；tauri-with-api.mjs
// 在 dev 时把它交给 VESTUS_CHROMIUM_PATH（见那里的注释）。

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const chromiumResourceDir = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "src-tauri",
  "resources",
  "chromium"
);

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/**
 * 铺好的 Chromium 可执行文件绝对路径；没铺好返回 `null`。
 *
 * 返回 `null` 时由调用方决定后果：dev 可以放着不管（Rust 侧会回退到系统装的
 * Chrome），打包必须报错。
 */
export function chromiumExecutable(directory = chromiumResourceDir) {
  if (process.platform === "win32") {
    const path = join(directory, "chrome.exe");
    return isFile(path) ? path : null;
  }
  if (process.platform !== "darwin") {
    const path = join(directory, "chrome");
    return isFile(path) ? path : null;
  }
  if (!existsSync(directory)) return null;
  const bundle = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(directory, entry.name))[0];
  if (!bundle) return null;
  const macosDir = join(bundle, "Contents", "MacOS");
  if (!existsSync(macosDir)) return null;
  const executable = readdirSync(macosDir, { withFileTypes: true }).find((entry) =>
    entry.isFile()
  );
  return executable ? join(macosDir, executable.name) : null;
}
