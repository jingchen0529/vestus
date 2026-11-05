/**
 * 「帮助分组 / 帮助内容」两个管理页共用的数据层。
 *
 * 后端只有整篇文档的 GET / PUT / DELETE，没有单条接口，所以这里的做法是：
 * 本地算出新的整篇文档 → 复用 `validateFaqDocument` 做一次全量校验 → 整篇 PUT。
 * 好处是新增/编辑/排序/停用都是同一条路径，不依赖后端改动，也不会出现
 * 「列表里改了但客户端没生效」的中间态——弹窗点保存即生效。
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
  DesktopFaqDocument,
  faqDocumentToDrafts,
  faqGroupsFrom,
  validateFaqDocument,
} from "@/types/desktop-faq";

export interface DesktopFaqController {
  loading: boolean;
  saving: boolean;
  doc: DesktopFaqDocument;
  /** 后台是否已自定义；false 表示当前展示的是随版本内置的内容。 */
  isCustomized: boolean;
  updatedAt: string | null;
  reload: () => Promise<void>;
  /** 校验 + 整篇保存。校验不通过时抛错，由调用方的弹窗就地提示。 */
  commit: (next: DesktopFaqDocument, successMessage: string) => Promise<void>;
  /** 清空自定义，回退到内置内容。 */
  reset: () => Promise<void>;
}

export function useDesktopFaq(): DesktopFaqController {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [doc, setDoc] = useState<DesktopFaqDocument>({ groups: [] });
  const [isCustomized, setIsCustomized] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDesktopFaq();
      setIsCustomized(data.faq !== null);
      setUpdatedAt(data.updatedAt);
      // GET 返回的 faq 是分组数组，模板返回的是 { groups }，统一成文档形状再用。
      const groups = faqGroupsFrom(data.faq);
      if (groups.length > 0) {
        setDoc({ groups });
      } else {
        // 未自定义：把内置内容当作「待发布的草稿」铺进列表，管理员看到的就是
        // 客户端当前展示的内容；第一次保存才会真正落库。
        const template = await api.getDesktopFaqTemplate();
        setDoc({ groups: faqGroupsFrom(template.faq) });
      }
    } catch (error) {
      toast.error("加载帮助内容失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const commit = useCallback(async (next: DesktopFaqDocument, successMessage: string) => {
    // 全量校验：上限、空值、同组重题都在这里拦住，错误文案带「第 N 组第 M 条」定位。
    const validationError = validateFaqDocument(faqDocumentToDrafts(next));
    if (validationError) throw new Error(validationError);

    setSaving(true);
    try {
      const saved = await api.saveDesktopFaq(next);
      setDoc(next);
      setIsCustomized(true);
      setUpdatedAt(saved.updatedAt);
      toast.success(successMessage, { description: "桌面端「常见问题」即时生效" });
    } finally {
      setSaving(false);
    }
  }, []);

  const reset = useCallback(async () => {
    setSaving(true);
    try {
      await api.resetDesktopFaq();
      setIsCustomized(false);
      setUpdatedAt(null);
      const template = await api.getDesktopFaqTemplate();
      setDoc({ groups: faqGroupsFrom(template.faq) });
      toast.success("已恢复默认", { description: "客户端将展示内置帮助内容" });
    } finally {
      setSaving(false);
    }
  }, []);

  return { loading, saving, doc, isCustomized, updatedAt, reload, commit, reset };
}

/** 改文档前先深拷贝，避免直接改 React state 里的对象。 */
export function cloneFaqDocument(doc: DesktopFaqDocument): DesktopFaqDocument {
  return {
    groups: doc.groups.map((group) => ({
      title: group.title,
      status: group.status,
      items: group.items.map((item) => ({
        question: item.question,
        answer: item.answer,
        status: item.status,
      })),
    })),
  };
}
