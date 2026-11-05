import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 解析器是纯 TypeScript 源码，`node --test` 不认 .ts：用本地 typescript 把它转成
 * ESM 落到临时目录再 import，这样测的是真代码而不是源码正则。
 */
const compiledDir = await mkdtemp(path.join(os.tmpdir(), "vestus-faq-md-"));
const markdownSource = await readFile(
  path.join(webRoot, "src/types/desktop-faq-markdown.ts"),
  "utf8",
);
const compiledPath = path.join(compiledDir, "desktop-faq-markdown.mjs");
await writeFile(
  compiledPath,
  ts.transpileModule(markdownSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: "desktop-faq-markdown.ts",
  }).outputText,
  "utf8",
);
const { parseFaqMarkdown, faqDraftsToMarkdown } = await import(pathToFileURL(compiledPath).href);

const FIXTURE = `# 常见问题

## 日常使用

### 点击「方舟」为什么不用输入账号密码？

系统已由管理员在后台为您的客户端账号绑定了方舟账号。

### 重复点击方舟入口，会打开多个窗口吗？

不会。

## 不小心退出了方舟账号怎么办

### 不小心点了「退出登录」，怎么办？

不用担心，系统会自动恢复：
1. 客户端会自动关闭该方舟窗口；
2. 平台列表里，方舟卡片会显示「自动恢复登录中」。

## 旧版说明 {-}

### 这条已经下线了吗？

是的，内容保留但客户端不展示。
`;

test("按「## 分组 / ### 问题」解析出分组与问答", () => {
  const result = parseFaqMarkdown(FIXTURE);
  assert.equal(result.errorCount, 0);
  assert.equal(result.groups.length, 3);
  assert.deepEqual(
    result.groups.map((group) => [group.title, group.items.length]),
    [
      ["日常使用", 2],
      ["不小心退出了方舟账号怎么办", 1],
      ["旧版说明", 1],
    ],
  );
  // 一级标题是文档标题，不参与分组。
  assert.ok(!result.groups.some((group) => group.title === "常见问题"));
});

test("答案正文保留分段与有序列表，不做 Markdown 渲染", () => {
  const result = parseFaqMarkdown(FIXTURE);
  const answer = result.groups[1].items[0].answer;
  assert.equal(
    answer,
    "不用担心，系统会自动恢复：\n1. 客户端会自动关闭该方舟窗口；\n2. 平台列表里，方舟卡片会显示「自动恢复登录中」。",
  );
});

test("标题末尾 {-} 表示停用", () => {
  const result = parseFaqMarkdown(FIXTURE);
  const disabled = result.groups[2];
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.title, "旧版说明");
  assert.equal(disabled.items[0].status, "active");
});

test("结构错误带行号：问题没有分组、分组没有问题、问题没有答案", () => {
  const orphan = parseFaqMarkdown("### 没有分组的问题\n答案");
  assert.equal(orphan.errorCount, 1);
  assert.equal(orphan.issues[0].line, 1);
  assert.match(orphan.issues[0].message, /问题必须写在「## 分组」下面/);

  const emptyGroup = parseFaqMarkdown("## 只有标题的分组\n");
  assert.equal(emptyGroup.errorCount, 1);
  assert.equal(emptyGroup.issues[0].line, 1);
  assert.match(emptyGroup.issues[0].message, /下面还没有问题/);

  const noAnswer = parseFaqMarkdown("## 分组\n\n### 有问没答？\n\n### 下一条？\n答案在这里。");
  assert.equal(noAnswer.errorCount, 1);
  assert.equal(noAnswer.issues[0].line, 3);
  assert.match(noAnswer.issues[0].message, /下面还没有答案正文/);
});

test("代码块里的 ### 不被当成新问题", () => {
  const result = parseFaqMarkdown(
    ["## 分组", "", "### 怎么配置？", "示例：", "```", "### 这只是代码里的注释", "```", "结束。"].join("\n"),
  );
  assert.equal(result.errorCount, 0);
  assert.equal(result.groups[0].items.length, 1);
  assert.match(result.groups[0].items[0].answer, /### 这只是代码里的注释/);
});

test("客户端渲染受限：加粗/列表放行，表格与行内代码给出提示", () => {
  const supported = parseFaqMarkdown("## 分组\n\n### 问题？\n请**不要**泄露密码。\n- 第一条\n- 第二条");
  assert.equal(supported.errorCount, 0);
  assert.equal(supported.warningCount, 0, "加粗和列表是客户端支持语法，不该再被提示");

  const unsupported = parseFaqMarkdown("## 分组\n\n### 问题？\n执行 `alembic upgrade head`。");
  assert.equal(unsupported.errorCount, 0);
  assert.equal(unsupported.warningCount, 1);
  assert.match(unsupported.issues[0].message, /行内代码/);
});

test("序列化 → 解析可往返，且格式幂等", () => {
  const source = [
    {
      title: "日常使用",
      status: "active",
      items: [
        { question: "问题一？", answer: "第一段。\n\n第二段。", status: "active" },
        { question: "问题二？", answer: "只有一行。", status: "disabled" },
      ],
    },
    { title: "旧说明", status: "disabled", items: [{ question: "问题三？", answer: "答。", status: "active" }] },
  ];
  const markdown = faqDraftsToMarkdown(source);
  const parsed = parseFaqMarkdown(markdown);
  assert.equal(parsed.errorCount, 0);
  assert.deepEqual(
    parsed.groups.map((group) => ({
      title: group.title,
      status: group.status,
      items: group.items.map((item) => ({
        question: item.question,
        answer: item.answer,
        status: item.status,
      })),
    })),
    source,
  );
  // 再整理一次不应再变（避免「点整理格式就有一堆 diff」）。
  assert.equal(faqDraftsToMarkdown(parsed.groups), markdown);
});

test("空的 Markdown 不编造内容，交给保存校验兜底", () => {
  const result = parseFaqMarkdown("   \n\n");
  assert.equal(result.groups.length, 0);
  assert.equal(result.errorCount, 0);
  assert.equal(faqDraftsToMarkdown([]), "");
});
