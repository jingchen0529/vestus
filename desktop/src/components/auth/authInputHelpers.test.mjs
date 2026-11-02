import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeNoWhitespace, preventSpaceKeyDown } from "./authInputHelpers.ts";

test("sanitizeNoWhitespace 能够去除首尾和中间的所有半角空格", () => {
  assert.equal(sanitizeNoWhitespace(" admin "), "admin");
  assert.equal(sanitizeNoWhitespace("a d m i n"), "admin");
  assert.equal(sanitizeNoWhitespace("  password123  "), "password123");
  assert.equal(sanitizeNoWhitespace("pass word 123"), "password123");
});

test("sanitizeNoWhitespace 能够去除全角空格、制表符、换行符等各类空白字符", () => {
  // 全角空格 \u3000
  assert.equal(sanitizeNoWhitespace("　admin　"), "admin");
  assert.equal(sanitizeNoWhitespace("ad　min"), "admin");
  // 制表符与换行符
  assert.equal(sanitizeNoWhitespace("\tadmin\n123\r"), "admin123");
  // 混合空白字符
  assert.equal(sanitizeNoWhitespace(" \t　user_01 \r\n"), "user_01");
});

test("sanitizeNoWhitespace 处理空字符串或无空格字符串正常", () => {
  assert.equal(sanitizeNoWhitespace(""), "");
  assert.equal(sanitizeNoWhitespace("admin"), "admin");
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
    key: "Spacebar",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);

  prevented = false;
  preventSpaceKeyDown({
    code: "Space",
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

  prevented = false;
  preventSpaceKeyDown({
    key: "Enter",
    code: "Enter",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
});

