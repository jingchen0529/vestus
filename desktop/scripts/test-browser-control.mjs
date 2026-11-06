// Gate the exact ignored Rust control test against bundled Chromium, never a user profile.
import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumExecutable } from "./chromium-resource.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = [
  "test", "--locked", "--lib",
  "cdp::control_tests::target_commands_work_against_a_real_browser",
  "--", "--ignored", "--exact", "--nocapture", "--test-threads=1",
];

// Keep the subprocess boundary injectable: Node regressions do not launch Chromium or Rust.
export async function runControlTest({
  env = process.env,
  resultDir = join(desktop, "test-results", "browser-control"),
  spawnProcess = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  mkdirSync(resultDir, { recursive: true });
  const logPath = join(resultDir, "control.log");
  writeFileSync(logPath, "");
  const startedAt = new Date().toISOString();
  let chrome = null;
  let capturedOut = "";
  let capturedErr = "";
  let failure = null;
  let exitCode = null;
  let signal = null;
  const recordError = (error) => {
    failure = String(error);
    capturedErr += `${failure}\n`;
    appendFileSync(logPath, `${failure}\n`);
    stderr.write(`${failure}\n`);
  };
  try {
    chrome = env.VESTUS_CONTROL_CHROMIUM || chromiumExecutable();
    if (!chrome || !isAbsolute(chrome) || !statSync(chrome, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("Chromium must be an existing absolute executable path. Prepare bundled Chromium with node scripts/prepare-chromium.mjs, or set VESTUS_CONTROL_CHROMIUM.");
    }
    accessSync(chrome, constants.X_OK);
    stdout.write(`Testing ${chrome}\nResults: ${resultDir}\n`);
    const result = await new Promise((resolveResult) => {
      const child = spawnProcess("cargo", [...args], {
        cwd: join(desktop, "src-tauri"),
        env: { ...env, VESTUS_CONTROL_CHROMIUM: chrome },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const [stream, destination, isError] of [
        [child.stdout, stdout, false], [child.stderr, stderr, true],
      ]) {
        stream?.on("data", (data) => {
          if (isError) capturedErr += data.toString();
          else capturedOut += data.toString();
          appendFileSync(logPath, data);
          destination.write(data);
        });
      }
      child.on("error", recordError);
      child.on("close", (code, closedSignal) => resolveResult({ code, signal: closedSignal }));
      // Promise also rejects a synchronous spawn failure.
    });
    exitCode = result.code;
    signal = result.signal;
  } catch (error) {
    recordError(error);
  }
  // A removed/renamed/ignored test must never turn this release gate green.
  const summaries = [...`${capturedOut}\n${capturedErr}`.matchAll(
    /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm,
  )];
  const ran = summaries.length === 1 && summaries[0][1] === "ok"
    && summaries[0][2] === "1" && summaries[0][3] === "0" && summaries[0][4] === "0";
  const passed = !failure && exitCode === 0 && !signal && ran;
  if (!passed && !failure) {
    const message = "Control gate requires cargo exit 0 without a signal and exactly 1 passing real-browser test, 0 failed, 0 ignored; refusing a false success.\n";
    appendFileSync(logPath, message);
    stderr.write(message);
  }
  writeFileSync(join(resultDir, "control.json"), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), platform: process.platform,
    architecture: process.arch, executable: chrome, args,
    exitCode, signal, passed, error: failure, stdout: capturedOut, stderr: capturedErr,
  }, null, 2) + "\n");
  return passed ? 0 : 1;
}

// Resolve both paths so macOS /var -> /private/var aliases cannot silently skip the CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: npm run test:control");
    process.exitCode = await runControlTest();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
