// Exercise the actual desktop Chromium lifecycle, never a user's existing profile.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumExecutable } from "./chromium-resource.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upgrade = process.argv.includes("--upgrade");
if (process.argv.slice(2).some((arg) => arg !== "--upgrade")) {
  throw new Error("Usage: npm run test:persistence [-- --upgrade]");
}
function executable(value, label) {
  if (!value || !isAbsolute(value) || !statSync(value, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} must be an existing absolute executable path. Prepare bundled Chromium with node scripts/prepare-chromium.mjs, or set VESTUS_PERSISTENCE_CHROMIUM.`);
  }
  return value;
}
const chrome = executable(process.env.VESTUS_PERSISTENCE_CHROMIUM || chromiumExecutable(), "Chromium");
const previous = upgrade
  ? executable(process.env.VESTUS_PERSISTENCE_PREVIOUS_CHROMIUM, "VESTUS_PERSISTENCE_PREVIOUS_CHROMIUM")
  : null;
if (previous === chrome) throw new Error("Upgrade testing requires two distinct Chromium versions.");
const resultDir = join(desktop, "test-results", "browser-persistence");
mkdirSync(resultDir, { recursive: true });
const name = upgrade ? "upgrade" : "persistence";
const log = createWriteStream(join(resultDir, `${name}.log`));
const args = ["test", "--locked", "--lib", upgrade
  ? "browser::persistence_tests::real_browser_upgrade_round_trip"
  : "browser::persistence_tests::", "--", "--ignored", "--nocapture", "--test-threads=1"];
if (!upgrade) args.push("--skip", "upgrade");
const startedAt = new Date().toISOString();
console.log(`Testing ${chrome}\nResults: ${resultDir}`);
const child = spawn("cargo", args, {
  cwd: join(desktop, "src-tauri"),
  env: { ...process.env, VESTUS_PERSISTENCE_CHROMIUM: chrome },
  stdio: ["inherit", "pipe", "pipe"],
});
let captured = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (data) => { captured += data.toString(); log.write(data); process.stdout.write(data); });
}
child.on("error", (error) => { captured += String(error); console.error(error); });
child.on("close", (code, signal) => {
  // A renamed/removed test must not turn an empty test selection into a passing gate.
  const ran = /test result: ok\. [1-9]\d* passed;/.test(captured);
  const status = code === 0 && ran ? 0 : 1;
  log.end();
  writeFileSync(join(resultDir, `${name}.json`), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), platform: process.platform,
    architecture: process.arch, executable: chrome, previousExecutable: previous,
    exitCode: code, signal, passed: status === 0,
  }, null, 2) + "\n");
  if (!ran && code === 0) console.error("No passing persistence tests executed; refusing a false success.");
  process.exitCode = status;
});
