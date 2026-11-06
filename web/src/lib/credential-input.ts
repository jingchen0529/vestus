import type { ChangeEvent, CompositionEvent, KeyboardEvent } from "react";
import { ACCOUNT_CHARSET_MESSAGE, PASSWORD_CHARSET_MESSAGE, sanitizeAccountChars, sanitizePasswordChars } from "./password-policy";

/** 与桌面端相同：拒绝组合输入，普通输入、粘贴和自动填充都经过白名单。 */
export function restrictedCredentialInput(
  field: "account" | "password",
  committed: string,
  onChange: (value: string) => void,
  onRejected: (message: string) => void,
) {
  const sanitize = field === "account" ? sanitizeAccountChars : sanitizePasswordChars;
  const message = field === "account" ? ACCOUNT_CHARSET_MESSAGE : PASSWORD_CHARSET_MESSAGE;
  const apply = (input: HTMLInputElement) => {
    const next = sanitize(input.value);
    const rejected = next !== input.value;
    if (rejected) input.value = next;
    onChange(next);
    if (rejected) onRejected(message);
  };
  return {
    onChange(event: ChangeEvent<HTMLInputElement>) {
      const native = event.nativeEvent as InputEvent & { keyCode?: number };
      if (native.isComposing || native.keyCode === 229) {
        event.currentTarget.value = committed;
        onRejected(message);
        return;
      }
      apply(event.currentTarget);
    },
    onCompositionEnd(event: CompositionEvent<HTMLInputElement>) {
      if (event.currentTarget.value !== committed) apply(event.currentTarget);
    },
    onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === " " || event.key === "\u3000" || event.code === "Space") {
        event.preventDefault();
        onRejected(message);
      }
    },
  };
}
