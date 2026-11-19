// Run the opt-in real-page material pagination regression against an already
// running VESTUS browser. The browser/profile stay outside this runner so the
// A/B launch variant and proxy are controlled by the caller.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
} = {}) {
  validateEnvironment(env);
  mkdirSync(resultDir, { recursive: true });
  const variant = env.VESTUS_MATERIAL_VARIANT;
  const resultPath = resolve(env.VESTUS_MATERIAL_RESULT || join(resultDir, `${variant}.json`));
  const logPath = join(resultDir, `${variant}.log`);
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
  try {
    const result = await new Promise((resolveResult) => {
      const child = spawnProcess("cargo", cargoArgs, {
        cwd: join(desktop, "src-tauri"),
        env: { ...env, VESTUS_MATERIAL_RESULT: resultPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (data) => record("stdout", data));
      child.stderr?.on("data", (data) => record("stderr", data));
      child.on("error", (error) => {
        spawnError = String(error);
      });
      child.on("close", (code, closedSignal) => resolveResult({ code, signal: closedSignal }));
    });
    exitCode = result.code;
    signal = result.signal;
  } catch (error) {
    spawnError = String(error);
  }

  const passed = !spawnError
    && exitCode === 0
    && !signal
    && output.includes(`test ${testName} ... ok`)
    && /test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(output)
    && (() => {
      try {
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        return result.variant === variant && result.rounds === 30
          && Array.isArray(result.samples) && result.samples.length === 31;
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
  const report = {
    variant,
    resultPath,
    logPath,
    exitCode,
    signal,
    passed,
    error: spawnError,
    stdout: output,
    stderr: errorOutput,
  };
  writeFileSync(join(resultDir, `${variant}.runner.json`), `${JSON.stringify(report, null, 2)}\n`);
  return passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: npm run test:material");
    process.exitCode = await runMaterialRegression();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
