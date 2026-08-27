// 把锁定版本的 Playwright Chromium 铺进 src-tauri/resources/chromium/，供
// tauri.<platform>.conf.json 的 resources 打进安装包。
//
// 三个平台的目标布局必须和 browser.rs:resolve_chromium_executable() 一致：
//   Windows  resources/chromium/chrome.exe
//   Linux    resources/chromium/chrome
//   macOS    resources/chromium/<浏览器>.app/Contents/MacOS/<可执行文件>
//            （Playwright 会随版本改这个名字：Chromium.app →
//             "Google Chrome for Testing.app"，所以 Rust 侧是扫描 .app 而不是
//             写死名字，这里也只保证「目录下有且仅有一个 .app」。）
//
// Chromium 二进制不能跨平台也不能跨架构，所以每个发布目标都必须在对应的
// runner 上原生执行本脚本（Windows x64 / macOS arm64 / macOS x64 / Linux x64）。
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 与 CI 产物一一对应的锁定版本；升级时同时更新 README 的说明。
const PLAYWRIGHT_VERSION = "1.62.1";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserCache = join(desktopRoot, ".cache", "ms-playwright");
const destination = join(desktopRoot, "src-tauri", "resources", "chromium");

// 各平台：Playwright 解压目录的前缀（新版带架构后缀，如 chrome-mac-arm64、
// chrome-win64、chrome-linux64），以及复制方式。
const layouts = {
  win32: { sourcePrefix: "chrome-win", bundled: false, executable: "chrome.exe" },
  linux: { sourcePrefix: "chrome-linux", bundled: false, executable: "chrome" },
  darwin: { sourcePrefix: "chrome-mac", bundled: true },
};

const layout = layouts[process.platform];
if (!layout) {
  throw new Error(`不支持的平台：${process.platform}`);
}

function download() {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npx, ["--yes", `playwright@${PLAYWRIGHT_VERSION}`, "install", "chromium"], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache },
  });
}

function directories(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

function appBundles(path) {
  return directories(path).filter((candidate) => candidate.endsWith(".app"));
}

// 只认有头 Chromium：chromium_headless_shell-* 是另一个二进制，桌面端不用它。
function findSourceDirectory() {
  if (!existsSync(browserCache)) {
    throw new Error(`Playwright 下载目录不存在：${browserCache}`);
  }
  const revisions = directories(browserCache)
    .filter((path) => /[\\/]chromium-\d+$/.test(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  for (const revision of revisions) {
    const source = directories(revision)
      .filter((path) => path.split(/[\\/]/).pop().startsWith(layout.sourcePrefix))
      .find((candidate) =>
        layout.bundled
          ? appBundles(candidate).length > 0
          : existsSync(join(candidate, layout.executable))
      );
    if (source) return source;
  }
  throw new Error(
    `下载目录中未找到 ${process.platform} 的完整 Chromium（期望 ${layout.sourcePrefix}*/${layout.bundled ? "*.app" : layout.executable}）`
  );
}

// 清空但保留 .gitkeep：该目录本身是被 git 跟踪的空壳（见 .gitignore）。
function resetDestination() {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(destination)) {
    if (entry === ".gitkeep") continue;
    rmSync(join(destination, entry), { recursive: true, force: true });
  }
}

function copy(source) {
  if (!layout.bundled) {
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    return;
  }
  // .app 里有符号链接和权限位，cp -R / cpSync 都会破坏 framework 结构；
  // ditto 是 Apple 自己的保真复制工具。同级的 ABOUT、resources 等附属文件
  // 浏览器启动时用不到，只搬 .app。
  const bundles = appBundles(source);
  if (bundles.length !== 1) {
    throw new Error(`${source} 下应当只有一个 .app，实际 ${bundles.length} 个`);
  }
  const bundle = bundles[0];
  execFileSync("ditto", [bundle, join(destination, bundle.split("/").pop())], {
    stdio: "inherit",
  });
}

// deb/AppImage 与 tauri 的资源复制都可能丢掉执行位，装上之后就成了
// 「找到文件却起不了进程」。这里显式补回来。
function restoreExecutableBits(executable) {
  if (process.platform === "win32") return;
  const extras =
    process.platform === "linux"
      ? ["chrome_crashpad_handler", "chrome_sandbox", "xdg-mime", "xdg-settings"]
      : [];
  for (const path of [executable, ...extras.map((name) => join(destination, name))]) {
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}

// 返回 browser.rs 会真正拿去启动的那个可执行文件路径。
function locateExecutable() {
  if (!layout.bundled) return join(destination, layout.executable);
  const bundle = appBundles(destination)[0];
  if (!bundle) throw new Error(`${destination} 下没有 .app`);
  const macosDir = join(bundle, "Contents", "MacOS");
  const files = readdirSync(macosDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (files.length === 0) throw new Error(`${macosDir} 下没有可执行文件`);
  return join(macosDir, files[0].name);
}

download();
const source = findSourceDirectory();
resetDestination();
copy(source);

const executable = locateExecutable();
restoreExecutableBits(executable);
if (!existsSync(executable) || !statSync(executable).isFile()) {
  throw new Error(`Chromium 资源准备失败，缺少可执行文件：${executable}`);
}
console.log(`chromium ready: ${executable}`);
