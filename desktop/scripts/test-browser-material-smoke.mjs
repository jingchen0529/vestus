// Synthetic smoke only: no business page, login, caller profile or memory acceptance.
import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumExecutable } from "./chromium-resource.mjs";
import { runMaterialRegression } from "./test-browser-material.mjs";
import { startMaterialFixture } from "./material-smoke-fixture.mjs";
import { spawnOwnedProcess } from "./process-tree.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = "Usage: node scripts/test-browser-material-smoke.mjs [--chromium ABSOLUTE_PATH] [--timeout-ms MILLISECONDS]";

export async function runMaterialSmoke({
  env = process.env,
  chromium = env.VESTUS_MATERIAL_SMOKE_CHROMIUM || chromiumExecutable(),
  resultDir = join(desktop, "test-results", "material-smoke"),
  timeoutMs = 300_000,
  cleanupTimeoutMs = 5_000,
  spawnProcess = spawn,
  signalProcess = process.kill.bind(process),
  platform = process.platform,
  stdout = process.stdout,
  stderr = process.stderr,
  abortSignal,
} = {}) {
  mkdirSync(resultDir, { recursive: true });
  const reportPath = join(resultDir, "smoke.json");
  const report = { schemaVersion: 1, mode: "synthetic-smoke", variant: "A", memoryAcceptance: false,
    gui: "not-run", login: "not-run", startedAt: new Date().toISOString(), timeoutMs,
    timedOut: false, aborted: false, rounds: 0, sampleCount: 0, observedPageFlips: 0,
    nextPageFlips: 0, previousPageFlips: 0, passed: false, error: null,
    cleanup: { passed: false, cargoTreeExited: true, browserTreeExited: true, serverClosed: true, ownedRootRemoved: true, error: null },
  };
  let root, rootIdentity, fixture, browser, timer, abortListener, cargoReport;
  const controller = new AbortController();
  const boundary = (path) => {
    const child = relative(root, resolve(path));
    if (!child || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child)) throw new Error("smoke result escapes owned root");
    return path;
  };
  const json = async (url) => {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error("local readiness HTTP failure");
    return response.json();
  };
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new Error("smoke timeout must be a finite positive integer no greater than 3600000ms");
    if (!chromium || !isAbsolute(chromium) || !statSync(chromium, { throwIfNoEntry: false })?.isFile()) throw new Error("Chromium must be an existing absolute executable path; prepare bundled Chromium or pass --chromium / VESTUS_MATERIAL_SMOKE_CHROMIUM");
    accessSync(chromium, constants.X_OK);
    if (abortSignal?.aborted) throw new Error("smoke aborted before browser launch");
    timer = setTimeout(() => { report.timedOut = true; controller.abort(); }, timeoutMs);
    abortListener = () => { report.aborted = true; controller.abort(); };
    abortSignal?.addEventListener("abort", abortListener, { once: true });
    root = mkdtempSync(join(tmpdir(), "vestus-material-smoke-"));
    rootIdentity = lstatSync(root);
    const profile = boundary(join(root, "profile"));
    const cargoDir = boundary(join(root, "cargo"));
    mkdirSync(profile);
    fixture = await startMaterialFixture();
    report.cleanup.serverClosed = false;
    const args = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--headless=new", "--window-size=1200,800", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-background-mode", "--disable-breakpad",
      "--disable-sync", "--disable-quic", "--no-proxy-server", "--password-store=basic", "--use-mock-keychain", fixture.url];
    browser = spawnOwnedProcess(chromium, args, { cwd: dirname(chromium), env, stdio: ["ignore", "pipe", "pipe"] }, { spawnProcess, platform, signalProcess });
    // Browser stderr may include local URLs/profile paths: it is deliberately not persisted.
    browser.child.stdout?.on("data", () => {}); browser.child.stderr?.on("data", () => {});
    report.cleanup.browserTreeExited = false;
    let target;
    while (!controller.signal.aborted) {
      if (browser.closed) throw new Error("owned browser exited before page readiness");
      try {
        const text = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
        const port = Number(text[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(text[1])) throw new Error("invalid owned DevToolsActivePort");
        const targets = await json(`http://127.0.0.1:${port}/json/list`);
        target = targets.find((item) => item.type === "page" && item.url === fixture.url && typeof item.id === "string");
        if (target && (await json(fixture.statsUrl)).ready) break;
      } catch (error) { if (controller.signal.aborted) throw error; }
      await delay(25);
    }
    if (controller.signal.aborted) throw new Error("smoke interrupted while waiting for ready page");
    const cargoEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("VESTUS_MATERIAL_")));
    Object.assign(cargoEnv, { VESTUS_MATERIAL_PROFILE: profile, VESTUS_MATERIAL_URL: fixture.url,
      VESTUS_MATERIAL_NEXT_SELECTOR: "[data-next]", VESTUS_MATERIAL_PREV_SELECTOR: "[data-prev]",
      VESTUS_MATERIAL_VARIANT: "A", VESTUS_MATERIAL_TARGET_ID: target.id, VESTUS_MATERIAL_SETTLE_MS: "100",
      VESTUS_MATERIAL_RESULT: boundary(join(cargoDir, "A.json")) });
    const status = await runMaterialRegression({ env: cargoEnv, resultDir: cargoDir, timeoutMs,
      cleanupTimeoutMs, abortSignal: controller.signal, spawnProcess, platform, signalProcess,
      stdout: { write() {} }, stderr: { write() {} } });
    cargoReport = JSON.parse(readFileSync(join(cargoDir, "A.runner.json"), "utf8"));
    report.cleanup.cargoTreeExited = cargoReport.cleanup.cargoTreeExited;
    report.timedOut ||= cargoReport.timedOut;
    if (status !== 0) throw new Error("material regression failed; named test, fresh result or cargo cleanup not accepted");
    const result = JSON.parse(readFileSync(join(cargoDir, "A.json"), "utf8"));
    report.rounds = result.rounds; report.sampleCount = result.samples.length;
    const counts = await json(fixture.statsUrl);
    Object.assign(report, { observedPageFlips: counts.observedPageFlips, nextPageFlips: counts.next, previousPageFlips: counts.previous });
    if (counts.observedPageFlips !== 60 || counts.next !== 30 || counts.previous !== 30 || counts.page !== 1 || counts.rejectedEvents !== 0) throw new Error("independent loopback server did not observe exactly 60 valid page changes");
    report.passed = true;
  } catch (error) {
    // Do not turn local paths, inherited business configuration or subprocess output into artifacts.
    report.error = error.name === "AbortError" ? "smoke timeout or cancellation" : String(error.message).replaceAll(root || "\0", "<owned-root>");
  } finally {
    clearTimeout(timer);
    if (abortListener) abortSignal?.removeEventListener("abort", abortListener);
    if (browser) {
      try { await browser.terminate(cleanupTimeoutMs); report.cleanup.browserTreeExited = true; }
      catch { report.cleanup.error = "owned browser tree exit was not confirmed"; }
    }
    if (fixture) {
      try { await fixture.close(); report.cleanup.serverClosed = true; }
      catch { report.cleanup.error = "loopback server close failed"; }
    }
    if (root) {
      report.cleanup.ownedRootRemoved = false;
      if (report.cleanup.cargoTreeExited && report.cleanup.browserTreeExited && report.cleanup.serverClosed) {
        try {
          const current = lstatSync(root);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) throw new Error("owned root identity changed");
          rmSync(root, { recursive: true, force: true }); report.cleanup.ownedRootRemoved = true;
        } catch { report.cleanup.error = "owned temporary root deletion failed"; }
      }
    }
    report.cleanup.passed = report.cleanup.cargoTreeExited && report.cleanup.browserTreeExited && report.cleanup.serverClosed && report.cleanup.ownedRootRemoved && !report.cleanup.error;
    report.passed &&= report.cleanup.passed && !report.timedOut && !report.aborted;
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  (report.passed ? stdout : stderr).write(`Synthetic material smoke ${report.passed ? "passed" : "failed"}; report: ${reportPath}\n`);
  return report.passed ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i], value = process.argv[i + 1];
      if (!value || !["--chromium", "--timeout-ms"].includes(key) || (key === "--chromium" ? options.chromium !== undefined : options.timeoutMs !== undefined)) throw new Error(usage);
      if (key === "--chromium") options.chromium = value; else options.timeoutMs = Number(value);
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try { process.exitCode = await runMaterialSmoke({ ...options, abortSignal: controller.signal }); }
    finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
