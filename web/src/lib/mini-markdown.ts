/**
 * 受限 Markdown 解析：只认客户端「常见问题」真正需要的四种语法。
 *
 * 为什么不用 react-markdown / marked：FAQ 的答案来自后台输入，语法面越宽，
 * 客户端越容易因为一段表格、一张图片、一段 HTML 撑破布局；而完整 Markdown
 * 解析器的输出是 HTML 字符串，落地就得 `dangerouslySetInnerHTML`。这里只解析成
 * 结构化的块和行内节点，交给 React 生成元素，天然不执行任何标签。
 *
 * 支持：
 * - 空行分段            → 段落
 * - `- ` / `* ` / `+ `  → 无序列表
 * - `1. ` / `1) `       → 有序列表
 * - `**文本**`          → 加粗
 * - 段内单换行          → 保留换行（渲染层用 whitespace-pre-wrap）
 *
 * 不支持（原样展示，不做半吊子解析）：代码块、引用、表格、链接、图片、标题。
 *
 * ⚠️ 本文件在 `web/src/lib/mini-markdown.ts` 有一份逐字副本：两个 app 是独立
 * package，没有共享层。两边的行为由 `web/test/mini-markdown.test.mjs` 用同一套
 * 用例比对，改动必须同时落两份，否则测试会挂。
 */

export type MiniInline = { type: "text" | "strong"; text: string };

export type MiniBlock =
  | { type: "paragraph"; lines: MiniInline[][] }
  | { type: "list"; ordered: boolean; items: MiniInline[][] };

const UNORDERED_ITEM = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED_ITEM = /^[ \t]*(\d{1,2})[.)][ \t]+(.*)$/;
const FENCE = /^[ \t]*(?:```|~~~)/;

/** 行内只处理加粗；未闭合的 `**` 原样保留为文本。 */
export function parseInline(text: string): MiniInline[] {
  const nodes: MiniInline[] = [];
  const pattern = /\*\*([^*\n]+)\*\*/g;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > cursor) {
      nodes.push({ type: "text", text: text.slice(cursor, match.index) });
    }
    nodes.push({ type: "strong", text: match[1] });
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) {
    nodes.push({ type: "text", text: text.slice(cursor) });
  }
  if (nodes.length === 0) {
    nodes.push({ type: "text", text });
  }
  return nodes;
}

export function parseMiniMarkdown(source: string): MiniBlock[] {
  const blocks: MiniBlock[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  let paragraph: MiniInline[][] | null = null;
  let list: { type: "list"; ordered: boolean; items: MiniInline[][] } | null = null;
  let inFence = false;

  const flushParagraph = (): void => {
    if (paragraph) {
      blocks.push({ type: "paragraph", lines: paragraph });
      paragraph = null;
    }
  };
  const flushList = (): void => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const raw of lines) {
    if (FENCE.test(raw)) {
      // 代码围栏只是标记，里面的内容按普通文本照原样走，不做等宽渲染。
      inFence = !inFence;
      flushParagraph();
      flushList();
      continue;
    }

    const line = raw.replace(/[ \t]+$/, "");
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (!inFence) {
      const unordered = UNORDERED_ITEM.exec(line);
      if (unordered) {
        flushParagraph();
        if (list && list.ordered) flushList();
        if (!list) list = { type: "list", ordered: false, items: [] };
        list.items.push(parseInline(unordered[1]));
        continue;
      }

      const ordered = ORDERED_ITEM.exec(line);
      if (ordered) {
        flushParagraph();
        if (list && !list.ordered) flushList();
        if (!list) list = { type: "list", ordered: true, items: [] };
        list.items.push(parseInline(ordered[2]));
        continue;
      }
    }

    flushList();
    if (!paragraph) paragraph = [];
    paragraph.push(parseInline(line));
  }

  flushParagraph();
  flushList();
  return blocks;
}
