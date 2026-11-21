// preflight/build 共用：验证触发版本、API 与版本说明后才写 GitHub 环境。
//   node desktop/scripts/prepare-release-api.mjs --github-actions
import { appendFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkReleaseNotes, releaseNotesPath, releaseVersionForEvent } from "./check-release-notes.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const placeholderApi = "https://vestus.invalid";

function configuredApi(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("API 配置必须是字符串");
  // URL/trim 会忽略部分原始控制字符；必须在规范化之前拒绝它们。
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error("API 配置不得含原始控制字符");
  }
  return value.trim();
}

function validatedApi(api) {
  const authority = api.match(/^https?:\/\/([^/?#\\]+)/i)?.[1];
  let parsed;
  try {
    parsed = new URL(api);
  } catch {
    throw new Error("API 配置必须是有效的完整 HTTP(S) 地址");
  }
  if (!authority || !/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || authority.includes("@") || /[?#\\]/.test(api)) {
    throw new Error("API 配置必须是无凭据、查询参数和片段的完整 HTTP(S) 地址");
  }
  return parsed;
}

function placeholderHost(host) {
  return host === "invalid" || host.endsWith(".invalid");
}

function localIpv4(host) {
  const [first] = host.split(".").map(Number);
  return host === "0.0.0.0" || first === 127;
}

function localHost(host) {
  if (isIP(host) === 4) return localIpv4(host);
  if (isIP(host) === 6) {
    const halves = host.split("::").map((part) => part ? part.split(":") : []);
    const words = halves.length === 1
      ? halves[0].map((word) => parseInt(word, 16))
      : [...halves[0], ...Array(8 - halves[0].length - halves[1].length).fill("0"), ...halves[1]].map((word) => parseInt(word, 16));
    if (words.slice(0, 6).every((word) => word === 0)) {
      return localIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`) || (words[6] === 0 && words[7] === 1);
    }
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return localIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    return false;
  }
  return ["localhost", "localhost.localdomain"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function resolveReleaseApi({ eventName, ref, inputApi, secretApi }) {
  const release = eventName === "push" && typeof ref === "string" && ref.startsWith("refs/tags/desktop-v");
  if (eventName === "push") {
    releaseVersionForEvent({ eventName, ref });
  } else if (eventName !== "workflow_dispatch") {
    throw new Error("API 配置只接受 desktop-v 标签推送或手动构建");
  }
  const input = configuredApi(inputApi);
  const secret = configuredApi(secretApi);
  if (release && !input && !secret) throw new Error("正式发布必须配置 HTTPS API");
  const api = input || secret || placeholderApi;
  const parsed = validatedApi(api);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (release && parsed.protocol !== "https:") throw new Error("正式发布的 API 必须使用 HTTPS");
  if (release && (placeholderHost(host) || localHost(host))) {
    throw new Error("正式发布的 API 不得使用占位或本机不可用地址");
  }
  return { api, allowInsecureApi: parsed.protocol === "http:", placeholder: placeholderHost(host) };
}

export function prepareReleaseApi(options, root = repositoryRoot, githubEnv) {
  const version = releaseVersionForEvent(options);
  const resolved = resolveReleaseApi(options);
  checkReleaseNotes(version, root, resolved.api);
  const notesPath = releaseNotesPath(version);
  if (!githubEnv) throw new Error("GitHub Actions 缺少 GITHUB_ENV");
  // 只写经过全部校验的单行值；失败不能留下半套 API/不安全开关。
  try {
    appendFileSync(githubEnv, `VESTUS_API_BASE_URL=${resolved.api}\nVESTUS_ALLOW_INSECURE_API=${resolved.allowInsecureApi ? "1" : "0"}\n`);
  } catch {
    throw new Error("无法写入 GitHub Actions 环境文件");
  }
  return { version, notesPath, ...resolved };
}

function run() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--github-actions") {
    throw new Error("用法：node desktop/scripts/prepare-release-api.mjs --github-actions");
  }
  const result = prepareReleaseApi({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    inputVersion: process.env.INPUT_VERSION,
    inputApi: process.env.INPUT_API_BASE_URL,
    secretApi: process.env.SECRET_API_BASE_URL,
  }, repositoryRoot, process.env.GITHUB_ENV);
  if (result.placeholder) {
    console.log("::warning::手动构建使用占位 API；产物只能验证打包流水线，无法登录");
  }
  if (result.allowInsecureApi) {
    console.log("::warning::手动构建显式使用不安全的 HTTP API");
  }
  console.log(`release API: ok (${result.allowInsecureApi ? "manual HTTP" : "HTTPS"})`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
