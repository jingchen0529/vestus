import type React from "react";

/** 需要严格限制字符集的登录字段。 */
export type AuthField = "account" | "password";

/**
 * 每个字段允许出现的字符（白名单，逐字符判定）：
 * - account：字母、数字、点、下划线、连字符、@，覆盖工号 / 邮箱 / 手机号等常见账号形态；
 * - password：可见 ASCII（0x21–0x7E），即排除空白、控制字符与全部非 ASCII 字符
 *   （中文、全角标点、emoji、零宽字符等）。
 */
const ALLOWED_CHAR: Record<AuthField, RegExp> = {
  account: /[A-Za-z0-9._@-]/,
  password: /[\x21-\x7E]/,
};

export interface SanitizeResult {
  /** 过滤后的值，只会包含该字段允许的字符 */
  value: string;
  /** 被剔除的字符数量（按码点计） */
  stripped: number;
  /** 是否发生了剔除 */
  changed: boolean;
}

/**
 * 按字段白名单过滤输入值。
 *
 * 逐码点遍历（`for...of`）而不是按 UTF-16 单元，避免 emoji 等代理对被拆成孤立字符；
 * 中文、全角字符、空白在 account 与 password 中都不属于白名单，会被直接剔除。
 */
export function sanitizeAuthValue(raw: string, field: AuthField): SanitizeResult {
  if (!raw) return { value: "", stripped: 0, changed: false };
  const allowed = ALLOWED_CHAR[field];
  let value = "";
  let stripped = 0;
  for (const char of raw) {
    if (allowed.test(char)) {
      value += char;
    } else {
      stripped += 1;
    }
  }
  return { value, stripped, changed: stripped > 0 };
}

/** 只取过滤后的字符串，忽略剔除计数。 */
export function sanitizeAuthText(raw: string, field: AuthField): string {
  return sanitizeAuthValue(raw, field).value;
}

/**
 * 判断当前事件是否发生在输入法（IME）组合过程中。
 *
 * 中文/日文等输入法组合时，事件带 isComposing 标记；部分 WebKit/Chromium 版本
 * 只在 keyCode 上给出 229。登录字段禁止中文进入输入值，因此这个判断用于
 * “识别组合并整段拒绝”，同时避免误拦键盘事件。
 */
export function isImeComposing(event: unknown): boolean {
  const e = event as
    | {
        isComposing?: boolean;
        keyCode?: number;
        nativeEvent?: { isComposing?: boolean; keyCode?: number } | null;
      }
    | null
    | undefined;
  if (!e) return false;
  if (e.isComposing) return true;
  if (e.nativeEvent?.isComposing) return true;
  if (e.keyCode === 229) return true;
  if (e.nativeEvent?.keyCode === 229) return true;
  return false;
}

/**
 * 键盘按下事件处理函数：阻止在输入框中输入空格（输入法组合过程中放行）。
 */
export function preventSpaceKeyDown(
  event: React.KeyboardEvent<HTMLInputElement> | { key?: string; code?: string; preventDefault: () => void }
): void {
  if (isImeComposing(event)) return;
  if (
    event.key === " " ||
    event.key === "Spacebar" ||
    event.code === "Space" ||
    event.key === "\u3000"
  ) {
    event.preventDefault();
  }
}
