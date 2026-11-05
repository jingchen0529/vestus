/** 桌面端「常见问题」帮助内容的类型与管理端表单模型。 */

export type FaqStatus = "active" | "disabled";

export interface FaqItem {
  id?: number;
  question: string;
  answer: string;
  status: FaqStatus;
}

export interface FaqGroup {
  id?: number;
  title: string;
  status: FaqStatus;
  items: FaqItem[];
}

/** PUT 请求体 / 模板接口里的文档形状。 */
export interface DesktopFaqDocument {
  groups: FaqGroup[];
}

/**
 * 管理端 GET / PUT 的响应：`faq` 是**分组数组**。
 *
 * 注意形状不统一：`GET /api/admin/desktop-faq/template` 返回的是 `{ faq: { groups } }`。
 * 后端 `services.desktop_faq._assemble()` 直接返回分组列表，模板接口则回的是常量文档。
 * 取值一律走 `faqGroupsFrom()`，别直接读 `.groups`——那正是 2026-11-05 管理端白屏的原因。
 */
export interface AdminDesktopFaqResponse {
  faq: FaqGroup[] | null;
  updatedAt: string | null;
}

/** 内置模板接口：`faq` 是完整文档（带 `groups` 包裹）。 */
export interface DesktopFaqTemplateResponse {
  faq: DesktopFaqDocument;
}

/** 客户端读取：同样是分组数组。 */
export interface UserDesktopFaqResponse {
  faq: FaqGroup[] | null;
}

/** 把两种返回形状统一成分组数组；`null` / 缺字段一律当作空。 */
export function faqGroupsFrom(
  payload: FaqGroup[] | DesktopFaqDocument | null | undefined,
): FaqGroup[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray((payload as DesktopFaqDocument).groups)) {
    return (payload as DesktopFaqDocument).groups;
  }
  return [];
}

/** 编辑器里的本地行：内容字段之外带一个稳定的本地 key，供 React 列表用。 */
export interface FaqItemDraft extends Omit<FaqItem, "id"> {
  localKey: string;
}

export interface FaqGroupDraft extends Omit<FaqGroup, "id" | "items"> {
  localKey: string;
  items: FaqItemDraft[];
}

let draftCounter = 0;
export function nextFaqLocalKey(): string {
  draftCounter += 1;
  return `faq-${Date.now()}-${draftCounter}`;
}

export function emptyFaqItemDraft(): FaqItemDraft {
  return { question: "", answer: "", status: "active", localKey: nextFaqLocalKey() };
}

export function emptyFaqGroupDraft(): FaqGroupDraft {
  return { title: "", status: "active", items: [emptyFaqItemDraft()], localKey: nextFaqLocalKey() };
}

/** 与后端 `app/schemas/desktop_faq.py` 同一套上限，前端先校验以定位到字段。 */
export const FAQ_LIMITS = {
  maxGroups: 20,
  maxItemsPerGroup: 50,
  maxItemsTotal: 200,
  maxTitleLength: 50,
  maxQuestionLength: 200,
  maxAnswerLength: 5000,
} as const;

const CONTROL_CHARACTER = /[\u0000-\u0009\u000B-\u001F\u007F]/;

/** 返回第一条不满足规则的文案（带定位），全部通过时返回 null。 */
export function validateFaqDocument(groups: FaqGroupDraft[]): string | null {
  if (groups.length === 0) {
    return "至少保留一个分组；要下线全部内容请使用「恢复默认」";
  }
  if (groups.length > FAQ_LIMITS.maxGroups) {
    return `最多 ${FAQ_LIMITS.maxGroups} 个分组`;
  }
  let total = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const label = `第 ${groupIndex + 1} 组「${group.title || "未命名分组"}」`;
    const title = group.title.trim();
    if (!title) return `${label}：分组标题不能为空`;
    if (title.length > FAQ_LIMITS.maxTitleLength) {
      return `${label}：分组标题不能超过 ${FAQ_LIMITS.maxTitleLength} 字`;
    }
    if (CONTROL_CHARACTER.test(title)) return `${label}：分组标题包含不允许的控制字符`;
    // 空分组允许存在（先建分组、再补问答）；客户端会把没有启用条目的分组过滤掉。
    if (group.items.length > FAQ_LIMITS.maxItemsPerGroup) {
      return `${label}：每个分组最多 ${FAQ_LIMITS.maxItemsPerGroup} 个问题`;
    }
    total += group.items.length;
    const seenQuestions = new Map<string, number>();
    for (let itemIndex = 0; itemIndex < group.items.length; itemIndex += 1) {
      const item = group.items[itemIndex];
      const itemLabel = `${label}第 ${itemIndex + 1} 条`;
      const question = item.question.trim();
      const answer = item.answer.trim();
      if (!question) return `${itemLabel}：问题不能为空`;
      if (question.length > FAQ_LIMITS.maxQuestionLength) {
        return `${itemLabel}：问题不能超过 ${FAQ_LIMITS.maxQuestionLength} 字`;
      }
      if (CONTROL_CHARACTER.test(question)) return `${itemLabel}：问题包含不允许的控制字符`;
      const first = seenQuestions.get(question);
      if (first !== undefined) {
        return `${label}第 ${first} 条与第 ${itemIndex + 1} 条问题重复，请修改后再保存`;
      }
      seenQuestions.set(question, itemIndex + 1);
      if (!answer) return `${itemLabel}：答案不能为空`;
      if (answer.length > FAQ_LIMITS.maxAnswerLength) {
        return `${itemLabel}：答案不能超过 ${FAQ_LIMITS.maxAnswerLength} 字`;
      }
      if (CONTROL_CHARACTER.test(answer)) return `${itemLabel}：答案包含不允许的控制字符`;
    }
  }
  if (total > FAQ_LIMITS.maxItemsTotal) {
    return `全部问题总数不能超过 ${FAQ_LIMITS.maxItemsTotal} 条`;
  }
  return null;
}

/** 编辑器草稿 → 保存请求体（去掉 localKey，字段做 strip）。 */
export function faqDraftsToPayload(groups: FaqGroupDraft[]): DesktopFaqDocument {
  return {
    groups: groups.map((group) => ({
      title: group.title.trim(),
      status: group.status,
      items: group.items.map((item) => ({
        question: item.question.trim(),
        answer: item.answer.trim(),
        status: item.status,
      })),
    })),
  };
}

/**
 * 服务端文档 → 编辑器草稿。
 *
 * localKey 按位置生成而不是用时间戳：同一份内容反复来回（文档 → 草稿 → Markdown →
 * 草稿）拿到的 key 一致，预览展开状态和 React 列表不会因为一次解析就重置。
 */
export function faqDocumentToDrafts(faq: DesktopFaqDocument | null): FaqGroupDraft[] {
  if (!faq || faq.groups.length === 0) return [];
  return faq.groups.map((group, groupIndex) => ({
    title: group.title,
    status: group.status,
    localKey: `g${groupIndex}`,
    items: group.items.map((item, itemIndex) => ({
      question: item.question,
      answer: item.answer,
      status: item.status,
      localKey: `g${groupIndex}-i${itemIndex}`,
    })),
  }));
}
