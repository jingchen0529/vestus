import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.resolve(webRoot, "../desktop");

/**
 * 受限 Markdown 解析器在管理端与桌面端各有一份逐字副本（两个 app 是独立 package）。
 * 这里把两份源码都 transpile 出来跑同一套用例：任何一边改了行为，测试立刻挂。
 */
async function loadParser(sourcePath) {
  const source = await readFile(sourcePath, "utf8");
  const dir = await mkdtemp(path.join(os.tmpdir(), "vestus-mini-md-"));
  const file = path.join(dir, "mini-markdown.mjs");
  await writeFile(
    file,
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      fileName: "mini-markdown.ts",
    }).outputText,
    "utf8",
  );
  return import(pathToFileURL(file).href);
}

const web = await loadParser(path.join(webRoot, "src/lib/mini-markdown.ts"));
const desktop = await loadParser(path.join(desktopRoot, "src/lib/mini-markdown.ts"));

const text = (value) => ({ type: "text", text: value });
const strong = (value) => ({ type: "strong", text: value });
const para = (...lines) => ({ type: "paragraph", lines });
const list = (ordered, ...items) => ({ type: "list", ordered, items });

const CASES = [
  { name: "空内容不产生块", input: "   \n\n", expected: [] },
  { name: "空行分段", input: "第一段。\n\n第二段。", expected: [para([text("第一段。")]), para([text("第二段。")])] },
  { name: "段内单换行合并为同一段的两行", input: "第一行\n第二行", expected: [para([text("第一行")], [text("第二行")])] },
  { name: "无序列表三种符号", input: "- 甲\n* 乙\n+ 丙", expected: [list(false, [text("甲")], [text("乙")], [text("丙")])] },
  { name: "有序列表两种写法", input: "1. 甲\n2) 乙", expected: [list(true, [text("甲")], [text("乙")])] },
  { name: "列表前的引导句独立成段", input: "您只需要等待：\n1. 甲\n2. 乙", expected: [para([text("您只需要等待：")]), list(true, [text("甲")], [text("乙")])] },
  { name: "列表后接段落要断开", input: "1. 甲\n\n补充说明", expected: [list(true, [text("甲")]), para([text("补充说明")])] },
  { name: "加粗解析为 strong", input: "请**不要**泄露", expected: [para([text("请"), strong("不要"), text("泄露")])] },
  { name: "未闭合的星号原样保留", input: "**没闭合", expected: [para([text("**没闭合")])] },
  { name: "标题不解析，按原文显示", input: "## 小标题", expected: [para([text("## 小标题")])] },
  { name: "表格不解析，按原文显示", input: "| a | b |", expected: [para([text("| a | b |")])] },
  { name: "代码围栏只当标记，内容按文本", input: "```\ncode\n```", expected: [para([text("code")])] },
  { name: "无序与有序相邻时各自成块", input: "- 甲\n1. 乙", expected: [list(false, [text("甲")]), list(true, [text("乙")])] },
  { name: "缩进的列表项也算列表", input: "  - 缩进项", expected: [list(false, [text("缩进项")])] },
  { name: "四位数不会被误判成有序列表", input: "2026. 年度总结", expected: [para([text("2026. 年度总结")])] },
];

for (const item of CASES) {
  test(`解析：${item.name}`, () => {
    assert.deepEqual(web.parseMiniMarkdown(item.input), item.expected);
  });
}

test("两端实现的行为完全一致", () => {
  for (const item of CASES) {
    assert.deepEqual(
      desktop.parseMiniMarkdown(item.input),
      web.parseMiniMarkdown(item.input),
      `两份副本在「${item.name}」上不一致`,
    );
  }
});

test("行内解析：多段加粗与尾随文本", () => {
  assert.deepEqual(web.parseInline("A**B**C**D**E"), [
    text("A"),
    strong("B"),
    text("C"),
    strong("D"),
    text("E"),
  ]);
});
