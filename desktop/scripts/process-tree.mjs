// Ownership is established at spawn, never by a global executable-name search.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { win32 } from "node:path";

// Keep a live group leader until cleanup: Node reaps direct children eagerly.
// The owned command exits over IPC while this supervisor still reserves its PID/PGID.
const supervisor = `
const {spawn}=require('node:child_process');
const keep=setInterval(()=>{},1000);
const child=spawn(process.argv[1],process.argv.slice(2),{stdio:['ignore',1,2]});
child.once('error',error=>process.send({code:null,signal:null,error:String(error)}));
child.once('exit',(code,signal)=>process.send({code,signal}));
process.once('disconnect',()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}});
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const helper = join(dirname(fileURLToPath(import.meta.url)), "process-tree.ps1");

function capture(command, args, spawnProcess, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    let text = "";
    let errorText = "";
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      reject(new Error("process-tree inspection timed out"));
    }, timeoutMs);
    try {
      child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child.stdout?.on("data", (data) => { text += data; });
      child.stderr?.on("data", (data) => { errorText += data; });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || errorText) reject(new Error("cannot inspect owned process group"));
        else resolve(text);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

export function spawnOwnedProcess(command, args, options, {
  spawnProcess = spawn,
  platform = process.platform,
  signalProcess = process.kill.bind(process),
} = {}) {
  const windows = platform === "win32";
  const native = spawnProcess === spawn;
  const acknowledgement = randomBytes(24).toString("hex");
  let systemRoot;
  if (windows) {
    systemRoot = options.env?.SystemRoot || process.env.SystemRoot;
    if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error("Windows ownership requires an absolute SystemRoot");
  }
  const executable = windows
    ? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : native ? process.execPath : command;
  if (windows && native && !statSync(executable, { throwIfNoEntry: false })?.isFile()) throw new Error("Windows ownership requires the system PowerShell executable");
  const commandArgs = windows
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper]
    : native ? ["-e", supervisor, command, ...args] : args;
  const child = spawnProcess(executable, commandArgs, {
    ...options,
    detached: !windows,
    windowsHide: true,
    ...(windows ? {
      env: { ...options.env, VESTUS_OWNED_COMMAND: JSON.stringify({ command, args }), VESTUS_OWNED_ACK: acknowledgement },
      stdio: ["pipe", "pipe", "pipe"],
    } : native ? { stdio: ["ignore", "pipe", "pipe", "ipc"] } : {}),
  });
  let closed = false;
  let commandExited = false;
  let failure = null;
  let jobConfirmed = false;
  let protocolBuffer = "";
  const completion = new Promise((resolve) => {
    if (!windows && native) child.once("message", (result) => { commandExited = true; resolve(result); });
    child.once("error", (error) => { failure = error; resolve({ code: null, signal: null, error }); });
    child.once("close", (code, signal) => { closed = true; resolve({ code, signal, error: failure }); });
  });
  if (windows) child.stderr?.on("data", (data) => {
    protocolBuffer += data;
    if (protocolBuffer.split(/\r?\n/).includes(`VESTUS_OWNED_JOB_EMPTY:${acknowledgement}`)) jobConfirmed = true;
    protocolBuffer = protocolBuffer.slice(-512);
  });
  let cleanup;
  return {
    child,
    completion,
    get closed() { return closed || Boolean(failure); },
    get commandExited() { return commandExited || closed || Boolean(failure); },
    terminate(timeoutMs = 5_000) {
      cleanup ??= (async () => {
        if (windows) {
          child.stdin?.end();
          const deadline = Date.now() + timeoutMs;
          while (!closed && Date.now() < deadline) await delay(20);
          if (failure && !child.pid) return true;
          if (!closed || !jobConfirmed) throw new Error("owned Windows Job exit was not confirmed");
          return true;
        }
        // Failed exec never created a tree. Also supports injected non-spawning child boundaries.
        if (!child.pid && (closed || failure)) return true;
        if (!Number.isSafeInteger(child.pid) || child.pid <= 1) throw new Error("invalid owned process-group leader");
        if (native && closed) throw new Error("owned supervisor exited before cleanup; refusing a recycled process-group id");
        const deadline = Date.now() + timeoutMs;
        let sent = false;
        do {
          if (!sent) {
            // Signal only while the native supervisor is still alive. Never re-signal a reaped PID.
            try { signalProcess(-child.pid, "SIGKILL"); }
            catch (error) { if (!["ESRCH", "EPERM"].includes(error.code)) throw error; }
            sent = true;
          }
          const text = await capture("/bin/ps", ["-axo", "pgid=,stat="], spawnProcess, Math.max(1, deadline - Date.now()));
          if (!text.trim()) throw new Error("empty process-group inspection");
          let live = false;
          for (const line of text.trim().split("\n")) {
            const fields = line.trim().split(/\s+/);
            if (fields.length !== 2 || !/^\d+$/.test(fields[0])) throw new Error("invalid process-group inspection");
            if (Number(fields[0]) === child.pid && !fields[1].startsWith("Z")) live = true;
          }
          if (closed && !live) return true;
          await delay(20);
        } while (Date.now() < deadline);
        throw new Error("owned process group did not finish exiting");
      })();
      return cleanup;
    },
  };
}
