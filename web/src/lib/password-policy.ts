/**
 * 密码字符集：管理端必须与桌面客户端保持一致。
 *
 * 桌面端密码输入框只接受可见 ASCII（0x21–0x7E），中文、空格、全角符号和 emoji
 * 都无法输入。管理端如果允许设置这类密码，用户就会拿着一个桌面上敲不出来的密码
 * 去登录，因此这里在输入与提交两处使用同一口径。
 */

export const ACCOUNT_CHARSET_MESSAGE = "账号只能包含英文字母、数字、点、下划线、@ 和连字符";
export const PASSWORD_CHARSET_MESSAGE = "密码只能包含可见 ASCII 字符（不含中文、空格或全角符号）";

const ACCOUNT_CHARACTERS = /^[A-Za-z0-9._@-]+$/;
const VISIBLE_ASCII = /^[\x21-\x7E]+$/;

export function sanitizeAccountChars(raw: string): string {
  return [...raw].filter(char => ACCOUNT_CHARACTERS.test(char)).join("");
}

export function accountCharsetError(account: string): string | null {
  return account && !ACCOUNT_CHARACTERS.test(account) ? ACCOUNT_CHARSET_MESSAGE : null;
}

/** 逐码点过滤，只留下可见 ASCII；输入法上屏的中文因此不会停留在输入框里。 */
export function sanitizePasswordChars(raw: string): string {
  let value = "";
  for (const char of raw) {
    if (VISIBLE_ASCII.test(char)) value += char;
  }
  return value;
}

/** 提交前校验；合法返回 null，否则返回给用户看的提示。 */
export function passwordCharsetError(password: string): string | null {
  return password && !VISIBLE_ASCII.test(password) ? PASSWORD_CHARSET_MESSAGE : null;
}
