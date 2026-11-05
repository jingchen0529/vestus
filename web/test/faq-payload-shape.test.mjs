import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 帮助内容接口的两种返回形状：
 * - `GET /api/admin/desktop-faq` 与 `PUT` → `data.faq` 是**分组数组**
 * - `GET /api/admin/desktop-faq/template` → `data.faq` 是 `{ groups: [...] }`
 *
 * 2026-11-05 管理端白屏（`Cannot read properties of undefined (reading 'map')`）就是
 * 直接把数组当文档用导致的。这里锁住归一化函数，避免同样的坑再踩一次。
 */
const source = await readFile(path.join(webRoot, "src/types/desktop-faq.ts"), "utf8");
const dir = await mkdtemp(path.join(os.tmpdir(), "vestus-faq-types-"));
const compiled = path.join(dir, "desktop-faq.mjs");
await writeFile(
  compiled,
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: "desktop-faq.ts",
  }).outputText,
  "utf8",
);
const { faqGroupsFrom } = await import(pathToFileURL(compiled).href);

const group = { title: "日常使用", status: "active", items: [] };

test("数组形状（管理端 GET / PUT）原样返回", () => {
  assert.deepEqual(faqGroupsFrom([group]), [group]);
});

test("文档形状（模板接口）取出 groups", () => {
  assert.deepEqual(faqGroupsFrom({ groups: [group] }), [group]);
});

test("null / undefined / 缺字段一律当空，不抛错", () => {
  assert.deepEqual(faqGroupsFrom(null), []);
  assert.deepEqual(faqGroupsFrom(undefined), []);
  assert.deepEqual(faqGroupsFrom({}), []);
});

test("数据层只用 faqGroupsFrom 取值，不直接读 .faq.groups", async () => {
  const hook = await readFile(path.join(webRoot, "src/hooks/use-desktop-faq.ts"), "utf8");
  assert.match(hook, /faqGroupsFrom\(data\.faq\)/);
  assert.match(hook, /faqGroupsFrom\(template\.faq\)/);
  assert.ok(!/setDoc\(data\.faq\)/.test(hook), "不能把接口原值直接塞进 doc");
  assert.ok(!/setDoc\(template\.faq\)/.test(hook), "模板也要先解包");
});
