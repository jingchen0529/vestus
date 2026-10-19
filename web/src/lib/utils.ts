import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(isoString?: string | null): string {
  if (!isoString) return "—";
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return isoString;
  }
}

const BEIJING_PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function beijingParts(date: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const { type, value } of BEIJING_PARTS_FORMATTER.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  return parts;
}

/** 不带时区标记的日期时间串按 UTC 解析：new Date 默认当成本地时间，会让同一时刻导出成不同结果。 */
const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * 导出用的北京时间（UTC+8）格式，形如 `2026-10-19 14:30:00`。
 *
 * 导出文件会拿到别的时区打开，不能像表格显示那样跟随机器本地时区；也不带 ISO 的
 * "T"/"Z" 标记。解析不了的值原样返回，空值返回空串。
 */
export function formatBeijingDateTime(value?: string | null): string {
  if (!value) return "";
  const text = value.trim();
  if (!text) return "";
  const normalized = NAIVE_DATE_TIME.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  const parts = beijingParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** 文件名用的北京时间日期戳（`YYYY-MM-DD`），避免 UTC 日期在晚上导出时差一天。 */
export function beijingDateStamp(now: Date = new Date()): string {
  const parts = beijingParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * 毫秒转成紧凑的中文时长，给前台停留这类累计值用。
 *
 * 只保留两级单位：一小时以上不再显示秒，读数的人关心的是量级。
 */
export function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

export function generateRandomPassword(length: number = 12): string {
  const lowercase = "abcdefghijkmnopqrstuvwxyz";
  const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*";
  const all = lowercase + uppercase + digits + symbols;

  let password = "";
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += digits[Math.floor(Math.random() * digits.length)];
  password += symbols[Math.floor(Math.random() * symbols.length)];

  for (let i = 4; i < length; i++) {
    password += all[Math.floor(Math.random() * all.length)];
  }

  return password.split("").sort(() => 0.5 - Math.random()).join("");
}
