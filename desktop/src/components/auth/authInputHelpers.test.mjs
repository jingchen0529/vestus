import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeAuthValue,
  sanitizeAuthText,
  preventSpaceKeyDown,
  isImeComposing,
} from "./authInputHelpers.ts";

test("账号白名单：只保留字母、数字、点、下划线、连字符、@", () => {
  assert.equal(sanitizeAuthText("zhang.san_01@corp-x", "account"), "zhang.san_01@corp-x");
  assert.equal(sanitizeAuthText("13800138000", "account"), "13800138000");
});

test("账号字段剔除中文、全角字符与空白", () => {
  assert.equal(sanitizeAuthText("张三", "account"), "");
  assert.equal(sanitizeAuthText("zhang三san", "account"), "zhangsan");
  assert.equal(sanitizeAuthText("ad min", "account"), "admin");
  assert.equal(sanitizeAuthText("　admin　", "account"), "admin");
  assert.equal(sanitizeAuthText("admin！", "account"), "admin");
});

test("密码字段保留可见 ASCII，剔除中文、全角标点、空格、emoji", () => {
  assert.equal(sanitizeAuthText("Passw0rd!@#", "password"), "Passw0rd!@#");
  assert.equal(sanitizeAuthText("密码123", "password"), "123");
  assert.equal(sanitizeAuthText("abc中文def", "password"), "abcdef");
  assert.equal(sanitizeAuthText("pass word", "password"), "password");
  assert.equal(sanitizeAuthText("pass\u3000word", "password"), "password");
  assert.equal(sanitizeAuthText("pass😀word", "password"), "password");
});

test("sanitizeAuthValue 返回被剔除的字符数与变更标记", () => {
  const result = sanitizeAuthValue("zhang三san", "account");
  assert.equal(result.value, "zhangsan");
  assert.equal(result.stripped, 1);
  assert.equal(result.changed, true);

  const untouched = sanitizeAuthValue("zhangsan", "account");
  assert.equal(untouched.value, "zhangsan");
  assert.equal(untouched.stripped, 0);
  assert.equal(untouched.changed, false);
});

test("空值边界安全", () => {
  assert.equal(sanitizeAuthText("", "account"), "");
  assert.equal(sanitizeAuthText("", "password"), "");
});

test("preventSpaceKeyDown 阻止空格键按键事件", () => {
  let prevented = false;
  preventSpaceKeyDown({
    key: " ",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);

  prevented = false;
  preventSpaceKeyDown({
    key: "\u3000",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
});

test("preventSpaceKeyDown 不阻止普通字符按键事件", () => {
  let prevented = false;
  preventSpaceKeyDown({
    key: "a",
    code: "KeyA",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
});

test("isImeComposing 能识别输入法组合状态", () => {
  assert.equal(isImeComposing({ isComposing: true }), true);
  assert.equal(isImeComposing({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isImeComposing({ keyCode: 229 }), true);
  assert.equal(isImeComposing({ nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 65 }), false);
  assert.equal(isImeComposing(undefined), false);
});
