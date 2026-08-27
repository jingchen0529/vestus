import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_DEV_API_BASE_URL = "http://127.0.0.1:8000";

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validatedApiUrl(rawBase, { allowInsecureApi = false } = {}) {
  const raw = String(rawBase || "").trim();
  if (!raw) throw new Error("VESTUS_API_BASE_URL 不能为空");

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("VESTUS_API_BASE_URL 不是有效的网址");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "VESTUS_API_BASE_URL 必须是无账号、查询参数和片段的 http(s) 地址"
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLoopbackHost(parsed.hostname) &&
    !allowInsecureApi
  ) {
    throw new Error("VESTUS_API_BASE_URL 的非本机地址必须使用 HTTPS");
  }
  return parsed;
}

export function buildTauriConfigForApi(rawBase, options) {
  const api = validatedApiUrl(rawBase, options);
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ipc: http://ipc.localhost",
    `img-src 'self' ${api.origin}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { app: { security: { csp } } };
}

export function buildTauriArguments(args, rawBase, options) {
  const [command, ...rest] = args;
  if (!command) throw new Error("必须指定 Tauri 子命令");
  return [
    command,
    "--config",
    JSON.stringify(buildTauriConfigForApi(rawBase, options)),
    ...rest,
  ];
}

function run() {
  const inputArgs = process.argv.slice(2);
  const rawBase =
    process.env.VESTUS_API_BASE_URL?.trim() ||
    (inputArgs[0] === "dev" ? DEFAULT_DEV_API_BASE_URL : "");
  const args = buildTauriArguments(inputArgs, rawBase, {
    allowInsecureApi: process.env.VESTUS_ALLOW_INSECURE_API === "1",
  });
  const cli = fileURLToPath(
    new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url)
  );
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
