import { ManagedCookieInput } from "@/types/managed-platform";

/**
 * 托管账号弹窗的 Cookie 解析：同时接受两种管理员最容易拿到的格式。
 *
 * 1. 浏览器里直接复制的原始字符串：`name=value; name=value; ...`
 * 2. 完整 JSON 数组：`[{"name":..., "value":..., "domain":...}, ...]`
 *
 * 原始字符串没有携带 domain，必须由调用方传入（从方舟平台 URL 推导）；
 * JSON 数组里缺 domain 的条目也用同一个默认值兜底。
 */
export function parseCookieInput(
  raw: string,
  defaultDomain?: string,
): ManagedCookieInput[] {
  const text = raw.trim();
  if (!text) {
    throw new Error("Cookie 内容为空");
  }

  if (text.startsWith("[")) {
    return parseJsonCookies(text, defaultDomain);
  }
  return parseRawCookieString(text, defaultDomain);
}

/** 平台入口的 URL → Cookie 默认 domain（保留一级业务域，兼容子域共享会话）。 */
export function defaultCookieDomain(platformUrl?: string | null): string | undefined {
  if (!platformUrl) return undefined;
  try {
    const hostname = new URL(platformUrl).hostname.replace(/^\./, "");
    if (!hostname) return undefined;
    const labels = hostname.split(".");
    if (labels.length <= 2 || labels.some((label) => /^\d+$/.test(label))) {
      return hostname;
    }
    return `.${labels.slice(-2).join(".")}`;
  } catch {
    return undefined;
  }
}

function parseJsonCookies(
  text: string,
  defaultDomain?: string,
): ManagedCookieInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Cookie 必须是合法 JSON 数组或浏览器复制的 name=value; ... 字符串");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Cookie JSON 必须是非空数组");
  }
  const cookies: ManagedCookieInput[] = [];
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).value !== "string"
    ) {
      throw new Error("每条 Cookie 都必须包含 name 和 value");
    }
    const record = item as Record<string, unknown>;
    const domain =
      typeof record.domain === "string" && record.domain.trim()
        ? record.domain.trim()
        : defaultDomain;
    if (!domain) {
      throw new Error(`Cookie「${record.name}」缺少 domain，且无法自动推导`);
    }
    cookies.push({ ...record, name: record.name, domain } as ManagedCookieInput);
  }
  return cookies;
}

function parseRawCookieString(
  text: string,
  defaultDomain?: string,
): ManagedCookieInput[] {
  if (!defaultDomain) {
    throw new Error("无法确定 Cookie 的 domain，请改用 JSON 数组格式并填写 domain");
  }
  const byName = new Map<string, ManagedCookieInput>();
  for (const part of text.split(";")) {
    const segment = part.trim();
    if (!segment) continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const name = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (!name || !value) continue;
    // 浏览器行为：同名 Cookie 以最后一次出现为准。
    byName.set(name, { name, value, domain: defaultDomain, path: "/" });
  }
  if (byName.size === 0) {
    throw new Error("未解析到任何 Cookie，请确认格式为 name=value; name=value; ...");
  }
  return [...byName.values()];
}
