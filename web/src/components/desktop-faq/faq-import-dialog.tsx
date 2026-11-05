import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, FileUp, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DesktopFaqDocument } from "@/types/desktop-faq";
import { parseFaqMarkdown } from "@/types/desktop-faq-markdown";
import { cloneFaqDocument } from "@/hooks/use-desktop-faq";

interface FaqImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DesktopFaqDocument;
  saving: boolean;
  onImport: (next: DesktopFaqDocument, message: string) => Promise<void>;
}

const PLACEHOLDER = `## 日常使用

### 点击「方舟」为什么不用输入账号密码？
系统已由管理员绑定方舟账号，点入口就自动登录。

## 不小心退出了方舟账号怎么办

### 点了「退出登录」怎么办？
不用担心，系统会自动恢复登录。`;

/**
 * 批量导入：一次贴一整篇 Markdown，按「## 分组 / ### 问题」拆成条目。
 * 适合新版本一次性补十几条问答；单条增改用列表页的弹窗。
 */
export function FaqImportDialog({ open, onOpenChange, doc, saving, onImport }: FaqImportDialogProps) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const parsed = useMemo(() => parseFaqMarkdown(text), [text]);
  const itemCount = parsed.groups.reduce((sum, group) => sum + group.items.length, 0);
  const errors = parsed.issues.filter((issue) => issue.level === "error");

  const handleFile = async (file: File) => {
    try {
      const content = await file.text();
      setText(content);
      setError(null);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "读取文件失败");
    }
  };

  const handleSubmit = async () => {
    if (parsed.errorCount > 0) {
      const first = errors[0];
      setError(`还有 ${parsed.errorCount} 处格式错误，先修好再导入（第 ${first.line} 行：${first.message}）`);
      return;
    }
    if (parsed.groups.length === 0) {
      setError("没有解析到任何分组，请确认用「## 分组」+「### 问题」的写法");
      return;
    }
    setError(null);

    const incoming: DesktopFaqDocument = {
      groups: parsed.groups.map((group) => ({
        title: group.title,
        status: group.status,
        items: group.items.map((item) => ({
          question: item.question,
          answer: item.answer,
          status: item.status,
        })),
      })),
    };

    let next: DesktopFaqDocument;
    let message: string;
    if (mode === "replace") {
      next = incoming;
      message = `已替换为 ${incoming.groups.length} 组 / ${itemCount} 条`;
    } else {
      // 追加：同名分组直接续在后面，新分组按文件顺序加到最后。
      next = cloneFaqDocument(doc);
      for (const group of incoming.groups) {
        const existing = next.groups.find((entry) => entry.title.trim() === group.title.trim());
        if (existing) existing.items.push(...group.items);
        else next.groups.push(group);
      }
      message = `已追加 ${itemCount} 条问答`;
    }

    try {
      await onImport(next, message);
      setText("");
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "导入失败，请稍后重试");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>批量导入 Markdown</DialogTitle>
          <DialogDescription className="text-xs">
            用「## 分组」和「### 问题」组织内容，问题下面紧跟的正文就是答案。导入前会先校验。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <FileUp className="h-3.5 w-3.5" />
              选择 .md 文件
            </Button>
            <span className="text-[11px] text-muted-foreground">
              也可以直接粘贴；标题末尾加 <code className="rounded bg-muted px-1">{"{-}"}</code> 表示停用
            </span>
          </div>

          <Textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            rows={10}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            className="min-h-[220px] resize-y font-mono text-[12.5px] leading-6"
          />

          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            {parsed.groups.length > 0 ? (
              <span className="flex items-center gap-1 font-medium text-success">
                <Check className="h-3 w-3" />
                已识别 {parsed.groups.length} 个分组 · {itemCount} 条问答
              </span>
            ) : (
              <span className="text-muted-foreground">还没有识别到内容</span>
            )}
            {parsed.warningCount > 0 && (
              <span className="text-warning">{parsed.warningCount} 处提示（不影响导入）</span>
            )}
          </div>

          {parsed.groups.length > 0 && (
            <div className="max-h-28 space-y-1 overflow-auto rounded-lg border border-border/70 bg-muted/20 p-2">
              {parsed.groups.map((group, index) => (
                <div key={`${index}-${group.title}`} className="flex items-center gap-2 text-[11.5px]">
                  <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="truncate font-medium text-foreground">{group.title || "未命名分组"}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {group.items.length} 条
                  </span>
                </div>
              ))}
            </div>
          )}

          {errors.length > 0 && (
            <div className="max-h-24 space-y-0.5 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-2">
              {errors.slice(0, 6).map((issue, index) => (
                <p key={`${issue.line}-${index}`} className="text-[11.5px] text-destructive">
                  第 {issue.line} 行：{issue.message}
                </p>
              ))}
              {errors.length > 6 && (
                <p className="text-[11px] text-destructive/80">还有 {errors.length - 6} 处…</p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">导入方式</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { value: "append", label: "追加到现有内容", hint: "同名分组续在后面，其他分组不动" },
                  { value: "replace", label: "替换全部内容", hint: "现有问答会被这份文件完全覆盖" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMode(option.value)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    mode === option.value
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/70 hover:bg-muted/40",
                  )}
                >
                  <span className="block text-[12px] font-medium text-foreground">{option.label}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-foreground">
                    {option.hint}
                  </span>
                </button>
              ))}
            </div>
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
          <Button
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={saving || parsed.groups.length === 0 || parsed.errorCount > 0}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            确认导入
          </Button>
        </DialogFooter>

        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
