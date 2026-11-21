// Run the opt-in real-page material pagination regression against an already
// running VESTUS browser. The browser/profile stay outside this runner so the
// A/B launch variant and proxy are controlled by the caller.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess } from "./process-tree.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testName = "cdp::control_tests::material_selection_30_flip_regression";
const cargoArgs = [
  "test", "--locked", "--lib", testName,
  "--", "--ignored", "--exact", "--test-threads=1",
];

const requiredEnvironment = [
  "VESTUS_MATERIAL_PROFILE",
  "VESTUS_MATERIAL_URL",
  "VESTUS_MATERIAL_NEXT_SELECTOR",
  "VESTUS_MATERIAL_PREV_SELECTOR",
  "VESTUS_MATERIAL_VARIANT",
];

function validateEnvironment(env) {
  for (const name of requiredEnvironment) {
    if (!env[name]?.trim()) throw new Error(`${name} must be set for the material regression`);
  }
  if (!isAbsolute(env.VESTUS_MATERIAL_PROFILE)) {
    throw new Error("VESTUS_MATERIAL_PROFILE must be an absolute profile directory");
  }
  if (!statSync(env.VESTUS_MATERIAL_PROFILE, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("VESTUS_MATERIAL_PROFILE must point to an existing profile directory");
  }
  if (!/^(A|B)$/.test(env.VESTUS_MATERIAL_VARIANT)) {
    throw new Error("VESTUS_MATERIAL_VARIANT must be A or B");
  }
}

export async function runMaterialRegression({
  env = process.env,
  resultDir = join(desktop, "test-results", "material-regression"),
  spawnProcess = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  timeoutMs = Number(env.VESTUS_MATERIAL_TIMEOUT_MS || 300_000),
  cleanupTimeoutMs = 5_000,
  abortSignal,
  platform = process.platform,
  signalProcess = process.kill.bind(process),
} = {}) {
  validateEnvironment(env);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    throw new Error("material timeout must be a finite positive integer no greater than 3600000ms");
  }
  mkdirSync(resultDir, { recursive: true });
  const variant = env.VESTUS_MATERIAL_VARIANT;
  const resultPath = resolve(env.VESTUS_MATERIAL_RESULT || join(resultDir, `${variant}.json`));
  const logPath = join(resultDir, `${variant}.log`);
  // Never accept yesterday's JSON: cargo writes into a fresh directory for this invocation.
  const freshRoot = mkdtempSync(join(resolve(resultDir), ".material-run-"));
  const freshResultPath = join(freshRoot, "result.json");
  writeFileSync(logPath, "");
  let output = "";
  let errorOutput = "";
  let spawnError = null;
  let exitCode = null;
  let signal = null;
  const record = (stream, data) => {
    const text = data.toString();
    if (stream === "stdout") output += text;
    else errorOutput += text;
    appendFileSync(logPath, text);
    (stream === "stdout" ? stdout : stderr).write(data);
  };
  let owned;
  let timedOut = false;
  let aborted = false;
  let cargoTreeExited = true;
  let cleanupError = null;
  let timer;
  let abortListener;
  try {
    if (abortSignal?.aborted) throw new Error("material regression aborted before cargo launch");
    owned = spawnOwnedProcess("cargo", cargoArgs, {
      cwd: join(desktop, "src-tauri"),
      env: { ...env, VESTUS_MATERIAL_RESULT: freshResultPath },
      stdio: ["ignore", "pipe", "pipe"],
    }, { spawnProcess, platform, signalProcess });
    owned.child.stdout?.on("data", (data) => record("stdout", data));
    owned.child.stderr?.on("data", (data) => record("stderr", data));
    const interrupted = new Promise((resolveResult) => {
      timer = setTimeout(() => { timedOut = true; resolveResult({ code: null, signal: null }); }, timeoutMs);
      abortListener = () => { aborted = true; resolveResult({ code: null, signal: null }); };
      abortSignal?.addEventListener("abort", abortListener, { once: true });
    });
    const result = await Promise.race([owned.completion, interrupted]);
    exitCode = result.code;
    signal = result.signal;
    if (result.error) spawnError = String(result.error);
  } catch (error) {
    spawnError = String(error);
  } finally {
    clearTimeout(timer);
    if (abortListener) abortSignal?.removeEventListener("abort", abortListener);
    if (owned) {
      try { await owned.terminate(cleanupTimeoutMs); }
      catch (error) { cargoTreeExited = false; cleanupError = String(error); }
    }
  }

  const passed = !spawnError && !timedOut && !aborted && cargoTreeExited
    && exitCode === 0
    && !signal
    && output.includes(`test ${testName} ... ok`)
    && /test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(output)
    && (() => {
      try {
        const text = readFileSync(freshResultPath, "utf8");
        const result = JSON.parse(text);
        const valid = result.variant === variant && result.rounds === 30
          && Array.isArray(result.samples) && result.samples.length === 31;
        if (valid) {
          mkdirSync(dirname(resultPath), { recursive: true });
          writeFileSync(resultPath, text);
        }
        return valid;
      } catch {
        return false;
      }
    })();
  if (!passed && !spawnError) {
    const message = "Material regression requires one named passing test, 30 completed rounds, 31 samples, and 0 failures or ignored tests.\n";
    errorOutput += message;
    appendFileSync(logPath, message);
    stderr.write(message);
  }
  let freshResultRemoved = false;
  if (cargoTreeExited) {
    try { rmSync(freshRoot, { recursive: true, force: true }); freshResultRemoved = true; }
    catch (error) { cleanupError = String(error); }
  }
  const cleanup = { passed: cargoTreeExited && freshResultRemoved, cargoTreeExited, freshResultRemoved, callerProfileUntouched: true, error: cleanupError };
  const report = {
    variant,
    resultPath,
    logPath,
    exitCode,
    signal,
    passed: passed && cleanup.passed,
    timeoutMs,
    timedOut,
    aborted,
    cleanup,
    error: spawnError,
    stdout: output,
    stderr: errorOutput,
  };
  writeFileSync(join(resultDir, `${variant}.runner.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report.passed ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: npm run test:material");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try { process.exitCode = await runMaterialRegression({ abortSignal: controller.signal }); }
    finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
