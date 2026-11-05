import { useEffect, useState } from "react";
import { AlertTriangle, Eye, PencilLine } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MiniMarkdown } from "@/components/desktop-faq/MiniMarkdown";
import { FaqItem, FaqStatus, FAQ_LIMITS } from "@/types/desktop-faq";

export interface FaqItemSubmitValue {
  groupIndex: number;
  item: FaqItem;
}

interface FaqItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可选分组，用于下拉与「新增时默认落在哪个分组」。 */
  groups: { title: string; status: FaqStatus }[];
  /** null 表示新增。 */
  editing: { groupIndex: number; item: FaqItem } | null;
  defaultGroupIndex: number;
  saving: boolean;
  onSubmit: (value: FaqItemSubmitValue) => Promise<void>;
}

/**
 * 单条问答的新增 / 编辑弹窗。
 *
 * 答案用 Markdown 写（空行分段、`- ` 列表），右边「预览」按客户端纯文本口径展示，
 * 所见即所得——因为桌面端就是不渲染 Markdown 的，预览里看到换行和符号就是最终效果。
 */
export function FaqItemDialog({
  open,
  onOpenChange,
  groups,
  editing,
  defaultGroupIndex,
  saving,
  onSubmit,
}: FaqItemDialogProps) {
  const isEditing = editing !== null;
  const [groupIndex, setGroupIndex] = useState(0);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<FaqStatus>("active");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setGroupIndex(editing.groupIndex);
      setQuestion(editing.item.question);
      setAnswer(editing.item.answer);
      setStatus(editing.item.status);
    } else {
      setGroupIndex(Math.min(defaultGroupIndex, Math.max(groups.length - 1, 0)));
      setQuestion("");
      setAnswer("");
      setStatus("active");
    }
    setTab("write");
    setError(null);
  }, [open, editing, defaultGroupIndex, groups.length]);

  const validate = (): string | null => {
    const trimmedQuestion = question.trim();
    const trimmedAnswer = answer.trim();
    if (!trimmedQuestion) return "问题不能为空";
    if (trimmedQuestion.length > FAQ_LIMITS.maxQuestionLength) {
      return `问题不能超过 ${FAQ_LIMITS.maxQuestionLength} 字`;
    }
    if (!trimmedAnswer) return "答案不能为空";
    if (trimmedAnswer.length > FAQ_LIMITS.maxAnswerLength) {
      return `答案不能超过 ${FAQ_LIMITS.maxAnswerLength} 字`;
    }
    return null;
  };

  const handleSubmit = async () => {
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    try {
      await onSubmit({
        groupIndex,
        item: { question: question.trim(), answer: answer.trim(), status },
      });
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存失败，请稍后重试");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "编辑问答" : "新增问答"}</DialogTitle>
          <DialogDescription className="text-xs">
            保存后立即下发到桌面端「常见问题」，用户不需要升级客户端。
          </DialogDescription>
        </DialogHeader>

        {/* 内容区独立滚动：窗口矮的时候底栏不会跟着被裁掉 */}
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">所属分组</Label>
              <Select
                value={String(groupIndex)}
                onValueChange={(value) => setGroupIndex(Number(value))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择分组" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group, index) => (
                    <SelectItem key={`${index}-${group.title}`} value={String(index)}>
                      {group.title || "未命名分组"}
                      {group.status === "disabled" ? "（已停用）" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">展示状态</Label>
              <div className="flex h-10 items-center gap-2 rounded-md border border-border/70 px-3">
                <Switch
                  checked={status === "active"}
                  onCheckedChange={(checked) => setStatus(checked ? "active" : "disabled")}
                />
                <span className="text-xs text-muted-foreground">
                  {status === "active" ? "启用（客户端展示）" : "停用（保留内容，不下发）"}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">问题</Label>
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                {question.length} / {FAQ_LIMITS.maxQuestionLength}
              </span>
            </div>
            <Input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：我在方舟页面里不小心点了「退出登录」，怎么办？"
              maxLength={FAQ_LIMITS.maxQuestionLength}
            />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setTab("write")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                    tab === "write" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <PencilLine className="h-3.5 w-3.5" />
                  Markdown 编写
                </button>
                <button
                  type="button"
                  onClick={() => setTab("preview")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                    tab === "preview" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Eye className="h-3.5 w-3.5" />
                  客户端预览
                </button>
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                {answer.length} / {FAQ_LIMITS.maxAnswerLength}
              </span>
            </div>

            {tab === "write" ? (
              <Textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void handleSubmit();
                }}
                rows={8}
                spellCheck={false}
                placeholder={"答案正文。空行分段，列表直接写：\n1. 第一步；\n2. 第二步。"}
                className="min-h-[180px] resize-y font-mono text-[12.5px] leading-6"
              />
            ) : (
              <div className="min-h-[180px] rounded-md border border-border/70 bg-muted/30 px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground">
                {answer.trim() ? (
                  <MiniMarkdown source={answer} />
                ) : (
                  <span className="text-muted-foreground">（还没有填写答案）</span>
                )}
              </div>
            )}

            <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
              客户端支持空行分段、<code className="rounded bg-muted px-1">- </code>/
              <code className="rounded bg-muted px-1">1. </code>列表和
              <code className="rounded bg-muted px-1">**加粗**</code>
              ；表格、链接、行内代码会连同符号一起显示出来。
            </p>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11.5px] text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} loading={saving}>
            {isEditing ? "保存修改" : "添加问答"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
