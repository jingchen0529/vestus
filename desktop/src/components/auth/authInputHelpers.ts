import type React from "react";

/**
 * 过滤字符串中的所有空白字符（包括普通空格、全角空格、制表符、换行等）。
 */
export function sanitizeNoWhitespace(value: string): string {
  if (!value) return "";
  return value.replace(/\s+/g, "");
}

/**
 * 键盘按下事件处理函数：阻止在输入框中输入空格。
 */
export function preventSpaceKeyDown(
  event: React.KeyboardEvent<HTMLInputElement> | { key?: string; code?: string; preventDefault: () => void }
): void {
  if (
    event.key === " " ||
    event.key === "Spacebar" ||
    event.code === "Space" ||
    event.key === "\u3000"
  ) {
    event.preventDefault();
  }
}

