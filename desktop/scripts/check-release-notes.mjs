// 发版前校验同一提交里的版本说明，不启动构建、不访问网络。
//   node desktop/scripts/check-release-notes.mjs 0.2.13
//   node desktop/scripts/check-release-notes.mjs --github-actions
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const requiredSections = [
  "发布信息",
  "本次更新",
  "安装与升级",
  "后端配套",
  "验证结果",
  "已知限制",
];

export function releaseNotesPath(version) {
  // 与 stamp-version.mjs 一样只接受数字 x.y.z；额外拒绝首尾空白，避免路径和
  // GitHub output 被换行污染。不接受任意文件名或用户提供的路径。
  if (typeof version !== "string" || version !== version.trim() || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("版本号必须是 x.y.z，例如 0.2.13");
  }
  return `docs/releases/desktop-v${version}.md`;
}

export function releaseVersionForEvent({ eventName, ref, inputVersion }) {
  const tagPrefix = "refs/tags/desktop-v";
  let version;
  if (eventName === "push" && ref?.startsWith(tagPrefix)) {
    version = ref.slice(tagPrefix.length);
  } else if (eventName === "workflow_dispatch") {
    version = inputVersion;
    if (ref?.startsWith(tagPrefix) && version !== ref.slice(tagPrefix.length)) {
      throw new Error("手动构建的版本号必须与所选 desktop-v 标签一致");
    }
  } else {
    throw new Error("Release 只接受 desktop-v 标签推送或显式版本号的手动构建");
  }
  releaseNotesPath(version);
  return version;
}

function hasContent(lines) {
  const prose = lines
    .map((line) => line
      .replace(/^\s*(?:>\s*)*/, "")
      .replace(/^(?:[-+*]|\d+[.)])(?:\s+|$)/, "")
      .replace(/^\[[ xX]\](?:\s+|$)/, ""))
    .filter((line) => !/^\s*(?:#{1,6}\s|`{3,}|~{3,})/.test(line))
    .join("\n");
  return /[\p{L}\p{N}]/u.test(prose);
}

function releaseField(information, name) {
  const matches = [...information.matchAll(new RegExp(`^\\s*-[ \\t]+${name}[：:][ \\t]*(.+?)[ \\t]*$`, "gm"))];
  if (matches.length !== 1) {
    throw new Error(`发布信息必须包含唯一的「- ${name}：...」`);
  }
  return matches[0][1].trim().replace(/^`([^`]+)`$/, "$1");
}

export function validateReleaseNotes(version, source) {
  releaseNotesPath(version);
  if (typeof source !== "string") throw new Error("版本说明必须是 Markdown 文本");
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  if (!text.trim()) throw new Error("版本说明不能为空");
  if (text.includes("<!--")) throw new Error("版本说明含未闭合的 HTML 注释");
  if (/待填写|待补充|请填写|\b(?:TODO|TBD|FIXME)\b/i.test(text)) {
    throw new Error("版本说明仍有模板占位内容，请补齐实际内容（未验证的项目请明确写未验证）");
  }

  // 只识别围栏之外的标题：模板代码块或 HTML 注释不能冒充已填写章节。
  const titles = [];
  const sections = new Map();
  let current = null;
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
      }
      if (current) sections.get(current).push(line);
      continue;
    }
    if (marker) {
      fence = marker[1];
      if (current) sections.get(current).push(line);
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,2})[ \t]+(.+?)[ \t]*$/);
    if (heading) {
      const name = heading[2].replace(/[ \t]+#+$/, "");
      current = null;
      if (heading[1] === "#") {
        titles.push(name);
      } else {
        if (sections.has(name)) throw new Error(`版本说明章节重复：${name}`);
        sections.set(name, []);
        current = name;
      }
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  if (fence) throw new Error("版本说明含未闭合的代码围栏");
  if (titles.length !== 1 || titles[0] !== `Vestus desktop-v${version} 版本说明`) {
    throw new Error(`版本说明标题必须是「# Vestus desktop-v${version} 版本说明」，且与打包版本一致`);
  }
  for (const name of requiredSections) {
    if (!sections.has(name)) throw new Error(`版本说明缺少章节：${name}`);
    if (!hasContent(sections.get(name))) throw new Error(`版本说明章节不能为空：${name}`);
  }

  const information = sections.get("发布信息").join("\n");
  if (!hasContent([releaseField(information, "目标环境")])) {
    throw new Error("发布信息必须填写目标环境");
  }
  const apiBase = releaseField(information, "API 地址");
  let api;
  try {
    api = new URL(apiBase);
  } catch {
    throw new Error("发布信息的 API 地址必须是完整 HTTP(S) 地址");
  }
  if (!/^https?:$/.test(api.protocol) || !api.hostname || api.username || api.password || /[?#]/.test(apiBase)) {
    throw new Error("发布信息的 API 地址必须是无凭据、查询参数和片段的 HTTP(S) 地址");
  }
}

export function checkReleaseNotes(version, root = repositoryRoot) {
  const relativePath = releaseNotesPath(version);
  const path = resolve(root, relativePath);
  let source;
  try {
    if (!lstatSync(path).isFile()) throw new Error("版本说明必须是普通 Markdown 文件");
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`缺少版本说明：${relativePath}；请先编写并展示说明，确认后再提交打包`);
    }
    throw error;
  }
  validateReleaseNotes(version, source);
  return relativePath;
}

function run() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("用法：node desktop/scripts/check-release-notes.mjs <x.y.z | --github-actions>");
  const actions = args[0] === "--github-actions";
  const version = actions
    ? releaseVersionForEvent({
        eventName: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF,
        inputVersion: process.env.INPUT_VERSION,
      })
    : args[0];
  const notesPath = checkReleaseNotes(version);
  if (actions) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GitHub Actions 缺少 GITHUB_OUTPUT");
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnotes_path=${notesPath}\n`);
  }
  console.log(`release notes: ok (${notesPath})`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
