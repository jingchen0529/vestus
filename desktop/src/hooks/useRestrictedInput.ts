import { useCallback, useRef, useState } from "react";
import type React from "react";
import {
  isImeComposing,
  sanitizeAuthValue,
  type AuthField,
} from "@/components/auth/authInputHelpers";

export interface RestrictedInputProps {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement>) => void;
}

/**
 * 受控输入 + 严格白名单校验。
 *
 * 绑定方式：`value` 永远来自 React state，`onChange` 是唯一写入入口。
 * 键盘、粘贴、浏览器自动填充、输入法组合产生的文本，都必须经过 `sanitizeAuthValue`
 * 过滤后才允许写进 state —— state 里不会出现第二个真相来源，也不会出现中文。
 *
 * 中文输入法处理：组合（composition）期间输入法会把拼音直接写进 DOM 的 input.value。
 * 只要这段临时文本同步进 state，就会以“一串字母”或中文的形式留在输入框里。
 * 因此对带组合标记的输入事件整段拒绝：把 DOM 回滚到上一个已提交的合法值，
 * 浏览器随即取消这次组合，拼音与中文都不会进入输入值。
 */
export function useRestrictedInput(field: AuthField, initialValue = "") {
  const [value, setValue] = useState(() => sanitizeAuthValue(initialValue, field).value);
  /** 最近一次被接受并写入 state 的合法值，用于组合期间回滚 DOM。 */
  const committedRef = useRef(value);

  /** 把 DOM 恢复成最近一次合法值（不改 state）。 */
  const revertDom = useCallback((el: HTMLInputElement) => {
    if (el.value !== committedRef.current) {
      el.value = committedRef.current;
    }
  }, []);

  const commit = useCallback((next: string) => {
    committedRef.current = next;
    setValue(next);
  }, []);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const el = event.currentTarget;

      // 输入法组合中：整段拒绝，回滚 DOM，本次组合被浏览器取消。
      // 只依据事件自身的组合标记判断，不缓存组合状态，避免 compositionend 丢失后
      // 输入框被永久锁死（组合结束后的第一个普通 input 事件即可自动恢复）。
      if (isImeComposing(event.nativeEvent)) {
        revertDom(el);
        return;
      }

      // 普通输入 / 粘贴 / 自动填充：按白名单过滤后再写入 state。
      const next = sanitizeAuthValue(el.value, field).value;
      if (next !== el.value) {
        // 就地剔除非法字符，避免非法字符在受控回写上闪一下；
        // 指针位置跟随浏览器回调结果，粘贴场景下光标落在末尾。
        el.value = next;
      }
      commit(next);
    },
    [commit, field, revertDom]
  );

  const handleCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLInputElement>) => {
      // 兜底：个别输入法在 compositionend 时已把中文上屏，这里再过滤一次，
      // 保证进入 state 的仍然只有白名单字符。
      const el = event.currentTarget;
      const next = sanitizeAuthValue(el.value, field).value;
      if (next !== el.value) {
        el.value = next;
      }
      commit(next);
    },
    [commit, field]
  );

  const inputProps: RestrictedInputProps = {
    value,
    onChange: handleChange,
    onCompositionEnd: handleCompositionEnd,
  };

  return { value, setValue: commit, inputProps };
}
