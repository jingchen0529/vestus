import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { FaqStatus, FAQ_LIMITS } from "@/types/desktop-faq";

interface FaqGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null 表示新增。 */
  editing: { title: string; status: FaqStatus; itemCount: number } | null;
  saving: boolean;
  onSubmit: (group: { title: string; status: FaqStatus }) => Promise<void>;
}

export function FaqGroupDialog({
  open,
  onOpenChange,
  editing,
  saving,
  onSubmit,
}: FaqGroupDialogProps) {
  const isEditing = editing !== null;
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<FaqStatus>("active");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? "");
    setStatus(editing?.status ?? "active");
    setError(null);
  }, [open, editing]);

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("分组标题不能为空");
      return;
    }
    if (trimmed.length > FAQ_LIMITS.maxTitleLength) {
      setError(`分组标题不能超过 ${FAQ_LIMITS.maxTitleLength} 字`);
      return;
    }
    setError(null);
    try {
      await onSubmit({ title: trimmed, status });
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存失败，请稍后重试");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "编辑分组" : "新增分组"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isEditing
              ? `该分组下现有 ${editing.itemCount} 条问答，改标题不会影响内容。`
              : "分组就是客户端「常见问题」里可折叠的一栏，建好后到「帮助内容」里加问答。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">分组标题</Label>
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                {title.length} / {FAQ_LIMITS.maxTitleLength}
              </span>
            </div>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：不小心退出了方舟账号怎么办"
              maxLength={FAQ_LIMITS.maxTitleLength}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">展示状态</Label>
            <div className="flex h-10 items-center gap-2 rounded-md border border-border/70 px-3">
              <Switch
                checked={status === "active"}
                onCheckedChange={(checked) => setStatus(checked ? "active" : "disabled")}
              />
              <span className="text-xs text-muted-foreground">
                {status === "active" ? "启用（整组下发）" : "停用（整组不下发，内容保留）"}
              </span>
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
          <Button size="sm" onClick={() => void handleSubmit()} loading={saving}>
            {isEditing ? "保存修改" : "添加分组"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
