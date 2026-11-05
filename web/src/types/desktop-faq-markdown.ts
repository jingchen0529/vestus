/**
 * 帮助内容的 Markdown 编写格式。
 *
 * 后端契约始终是「分组 / 问答」结构（`DesktopFaqDocument`），Markdown 只是这套结构
 * 的**人写投影**：写的时候是一份 md，保存前解析回同一份 `FaqGroupDraft[]`，依旧走
 * `validateFaqDocument` 与原来的 PUT 接口。所以：
 *
 * - 后端、数据库、桌面端一行都不用改；
 * - 想加内容就是往 md 里多写两行，不用点一堆「添加分组 / 添加问题」；
 * - 需要改启用状态、排序、单条微调时，随时切回结构化编辑，两边共用同一份数据。
 *
 * 语法只有四条（见 `FAQ_MARKDOWN_SYNTAX`）：`##` 分组、`###` 问题、正文即答案、
 * 标题后缀 `{-}` 表示停用。一级标题只作文档标题，不参与分组。
 */

import type { FaqGroupDraft, FaqItemDraft, FaqStatus } from "@/types/desktop-faq";

/** 标题末尾加这个标记 = 停用（客户端不展示）。 */
export const FAQ_DISABLED_MARKER = "{-}";

export interface FaqMarkdownSyntaxRow {
  code: string;
  hint: string;
}

/** 编辑器里「语法说明」面板的唯一来源。 */
export const FAQ_MARKDOWN_SYNTAX: FaqMarkdownSyntaxRow[] = [
  { code: "## 分组标题", hint: "新建一个分组，客户端里对应可折叠的一栏" },
  { code: "### 一个问题？", hint: "分组下的问答，想加几条就写几个 ###" },
  { code: "答案正文", hint: "紧跟问题之后，空行分段，列表照常写「- 」或「1. 」" },
  { code: `## 旧说明 ${FAQ_DISABLED_MARKER}`, hint: "标题末尾加 {-} 表示停用，保留内容但客户端不展示" },
  { code: "# 常见问题", hint: "一级标题只作文档标题，不参与分组（分组统一用 ##）" },
];

export interface FaqMarkdownIssue {
  /** 1 起的行号，用于点击定位。 */
  line: number;
  level: "error" | "warning";
  message: string;
}

export interface FaqMarkdownParseResult {
  groups: FaqGroupDraft[];
  issues: FaqMarkdownIssue[];
  errorCount: number;
  warningCount: number;
}

/** 序列化只需要字段，不关心 localKey，所以把草稿与文档都收进来。 */
export interface FaqMarkdownSourceGroup {
  title: string;
  status: FaqStatus;
  items: readonly { question: string; answer: string; status: FaqStatus }[];
}

const HEADING_PATTERN = /^(#{1,6})[ \t]+(.*\S)[ \t]*$/;
const FENCE_PATTERN = /^[ \t]*(?:```|~~~)/;
const DOCUMENT_TITLE = /^(常见问题|帮助内容|帮助中心|使用帮助|faq|help)$/i;

/** 客户端答案正文按受限 Markdown 渲染（`**加粗**`、`- `/`1. ` 列表、空行分段、段内换行）。
 *  下面这些不在支持范围内，会连同符号一起显示，提前提醒。 */
const INLINE_MARKERS: { pattern: RegExp; label: string }[] = [
  { pattern: /`[^`\n]+`/, label: "`行内代码`" },
  { pattern: /^[ \t]*>[ \t]/, label: "> 引用" },
  { pattern: /\[[^\]\n]+\]\([^)\n]+\)/, label: "[文字](链接)" },
  { pattern: /^[ \t]*\|.*\|[ \t]*$/, label: "| 表格 |" },
];

function ellipsis(text: string, max = 16): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function splitStatus(raw: string): { title: string; status: FaqStatus } {
  const text = raw.trim();
  if (text.endsWith(FAQ_DISABLED_MARKER)) {
    return { title: text.slice(0, -FAQ_DISABLED_MARKER.length).trim(), status: "disabled" };
  }
  return { title: text, status: "active" };
}

function markerOf(status: FaqStatus): string {
  return status === "disabled" ? ` ${FAQ_DISABLED_MARKER}` : "";
}

/** 答案正文归一：去行尾空格、掐掉首尾空行、3 个以上空行压成 1 个空行。 */
function normalizeAnswer(lines: string[]): string {
  const joined = lines.join("\n").replace(/[ \t]+$/gm, "");
  return joined.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Markdown → 分组草稿。
 *
 * `localKey` 按位置生成（`g0` / `g0-i1`），同一份文本反复解析得到同样的 key，
 * React 列表和预览的展开状态不会因为一次按键就丢掉。
 */
export function parseFaqMarkdown(source: string): FaqMarkdownParseResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const groups: FaqGroupDraft[] = [];
  const issues: FaqMarkdownIssue[] = [];

  let group: FaqGroupDraft | null = null;
  let groupLine = 0;
  let item: FaqItemDraft | null = null;
  let itemLine = 0;
  let answer: string[] = [];
  let inFence = false;
  let inlineWarnings = 0;
  // 一处结构性错误会连带下面每一行都「无处安放」，只报第一条，避免刷屏。
  let suppressBodyErrors = false;

  const flushItem = () => {
    if (!group || !item) return;
    const text = normalizeAnswer(answer);
    const target = group;
    const draft = item;
    item = null;
    answer = [];
    draft.answer = text;
    target.items.push(draft);
    if (!text) {
      issues.push({
        line: itemLine,
        level: "error",
        message: `问题「${ellipsis(draft.question)}」下面还没有答案正文`,
      });
    }
  };

  const closeGroup = () => {
    flushItem();
    if (!group) return;
    if (group.items.length === 0) {
      issues.push({
        line: groupLine,
        level: "error",
        message: `分组「${ellipsis(group.title)}」下面还没有问题，请用「### 问题」补一条`,
      });
    }
    group = null;
  };

  const pushBody = (raw: string, line: number) => {
    if (!raw.trim()) {
      if (item) answer.push("");
      return;
    }
    if (!group) {
      if (suppressBodyErrors) return;
      suppressBodyErrors = true;
      issues.push({
        line,
        level: "error",
        message: "这行内容不在任何分组里，请先用「## 分组标题」开头",
      });
      return;
    }
    if (!item) {
      if (suppressBodyErrors) return;
      suppressBodyErrors = true;
      issues.push({
        line,
        level: "error",
        message: "这行正文没有对应的问题，请先用「### 问题」开头",
      });
      return;
    }
    answer.push(raw);
    if (inlineWarnings >= 6) return;
    for (const marker of INLINE_MARKERS) {
      if (!marker.pattern.test(raw)) continue;
      inlineWarnings += 1;
      issues.push({
        line,
        level: "warning",
        message: `客户端不支持 ${marker.label}，会连同符号一起显示`,
      });
      break;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;

    if (FENCE_PATTERN.test(raw)) {
      if (item) answer.push(raw);
      else if (raw.trim()) {
        issues.push({ line, level: "error", message: "代码块要写在某个问题的答案里" });
      }
      inFence = !inFence;
      continue;
    }

    if (!inFence) {
      const heading = HEADING_PATTERN.exec(raw);
      if (heading) {
        const level = heading[1].length;
        const rawTitle = heading[2];

        if (level === 1) {
          // 只吃「# 常见问题」这种文档标题；其它一级标题按分组兼容，避免误伤习惯写法。
          if (DOCUMENT_TITLE.test(rawTitle.trim())) continue;
          closeGroup();
          suppressBodyErrors = false;
          const parsed = splitStatus(rawTitle);
          group = {
            title: parsed.title,
            status: parsed.status,
            items: [],
            localKey: `g${groups.length}`,
          };
          groupLine = line;
          groups.push(group);
          continue;
        }

        if (level === 2) {
          closeGroup();
          suppressBodyErrors = false;
          const parsed = splitStatus(rawTitle);
          group = {
            title: parsed.title,
            status: parsed.status,
            items: [],
            localKey: `g${groups.length}`,
          };
          groupLine = line;
          groups.push(group);
          continue;
        }

        if (level === 3) {
          if (!group) {
            issues.push({
              line,
              level: "error",
              message: "问题必须写在「## 分组」下面，请先加一个分组标题",
            });
            suppressBodyErrors = true;
            continue;
          }
          flushItem();
          suppressBodyErrors = false;
          const parsed = splitStatus(rawTitle);
          const target = group;
          item = {
            question: parsed.title,
            answer: "",
            status: parsed.status,
            localKey: `${target.localKey}-i${target.items.length}`,
          };
          itemLine = line;
          continue;
        }

        issues.push({
          line,
          level: "warning",
          message: "「####」及更深的标题会作为答案正文原样展示；要新建问题请用「###」",
        });
      }
    }

    pushBody(raw, line);
  }

  closeGroup();

  return {
    groups,
    issues,
    errorCount: issues.filter((issue) => issue.level === "error").length,
    warningCount: issues.filter((issue) => issue.level === "warning").length,
  };
}

/** 分组草稿 → Markdown。`parse(serialize(x))` 与 `x` 的结构一致。 */
export function faqDraftsToMarkdown(groups: readonly FaqMarkdownSourceGroup[]): string {
  return groups
    .map((group) => {
      const blocks = [`## ${group.title || "未命名分组"}${markerOf(group.status)}`];
      for (const item of group.items) {
        const head = `### ${item.question || "（未填写问题）"}${markerOf(item.status)}`;
        const body = item.answer.replace(/[ \t]+$/gm, "").trim();
        blocks.push(body ? `${head}\n\n${body}` : head);
      }
      return blocks.join("\n\n");
    })
    .join("\n\n")
    .concat(groups.length > 0 ? "\n" : "");
}
