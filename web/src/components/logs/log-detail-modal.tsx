import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getLogPresentation, UserLogItem } from "@/types/log";
import { formatDate, cn } from "@/lib/utils";
import { Copy, Check } from "lucide-react";
import { toast } from "sonner";

interface LogDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  log: UserLogItem | null;
}

export function getLogDetails(
  log: Pick<UserLogItem, "details">,
): UserLogItem["details"] {
  return log.details ?? null;
}

/** 小号复制按钮：长串（Request ID / UA / JSON）都靠它落地。 */
function CopyChip({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setDone(true);
    toast.success(`${label}已复制`);
    setTimeout(() => setDone(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`复制${label}`}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      {done ? (
        <Check className="h-3 w-3 text-success" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      <span>{done ? "已复制" : "复制"}</span>
    </button>
  );
}

/** 定义列表的一项：标签在上，值在下，组内靠栅格对齐。 */
function Field({
  label,
  mono,
  children,
  className,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 truncate text-[13px] text-foreground",
          mono && "font-mono text-[12px]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function LogDetailModal({
  open,
  onOpenChange,
  log,
}: LogDetailModalProps) {
  if (!log) return null;
  const details = getLogDetails(log);
  const display = getLogPresentation(log);
  const targetLabels: Record<string, string> = {
    admin: "管理员", user: "桌面用户", role: "角色", system: "系统",
    proxy: "代理节点", platform: "平台", browser: "浏览器",
    desktop_faq: "桌面端帮助", managed_platform_account: "托管账号",
  };
  const ok = log.status === "SUCCESS";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl md:max-w-3xl">
        <div className="shrink-0 border-b border-border/70 px-6 pb-4 pt-5">
          <DialogTitle>审计日志详情 #{log.id}</DialogTitle>
          <DialogDescription className="mt-1.5 text-xs leading-relaxed">
            管理端、桌面端与系统操作的安全审计记录
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* 状态行：不用盒子，靠一条基线把状态、动作、时间排在一行 */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 text-[12px] font-medium",
                  ok ? "text-success" : "text-destructive",
                )}
              >
                <i
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    ok ? "bg-success" : "bg-destructive",
                  )}
                />
                {ok ? "执行成功" : "执行失败"}
              </span>
              <span className="text-[13px] font-semibold text-foreground">
                {display.actionLabel}
              </span>
              <Badge variant="outline" className="text-[10px] font-normal">
                {display.categoryLabel}
              </Badge>
            </div>
            <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
              {formatDate(log.createdAt)}
            </span>
          </div>

          {/* 主体信息：两列定义列表，靠细线分组而不是一层层边框 */}
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border/60 pt-4 sm:grid-cols-2">
            <Field label="操作人主体">
              <span className="font-medium">{display.actorName}</span>
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                {display.actorTypeLabel}
                {display.actorRoleLabel ? ` · ${display.actorRoleLabel}` : ""}
              </span>
            </Field>

            <Field label="来源 IP 地址" mono>
              {log.ipAddress || "—"}
            </Field>

            <Field label="关联目标对象">
              {log.targetType
                ? `${targetLabels[log.targetType] || "其他对象"}：${log.targetName || log.targetId || "未提供"}`
                : "全局动作"}
            </Field>

            <div className="min-w-0">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">请求编号</span>
                {log.requestId && <CopyChip value={log.requestId} label="请求编号" />}
              </div>
              <div
                className="mt-1 truncate font-mono text-[12px] text-foreground"
                title={log.requestId || ""}
              >
                {log.requestId || "—"}
              </div>
            </div>

            <Field label="事件代码" mono className="sm:col-span-2">
              <span className="inline-block max-w-full align-middle" title={log.action}>{log.action}</span>
            </Field>
          </div>

          {/* 操作摘要 */}
          <div className="mt-5 border-t border-border/60 pt-4">
            <div className="text-[11px] text-muted-foreground">操作摘要</div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-foreground">
              {log.summary || "无摘要说明"}
            </p>
          </div>

          {/* User Agent */}
          {log.userAgent && (
            <div className="mt-5 border-t border-border/60 pt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  客户端信息
                </span>
                <CopyChip value={log.userAgent} label="客户端信息" />
              </div>
              <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                {log.userAgent}
              </p>
            </div>
          )}

          {/* 结构化元数据：浅色代码块，不用反色黑底 */}
          {details && (
            <div className="mt-5 border-t border-border/60 pt-4">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  结构化元数据
                </span>
                <CopyChip value={JSON.stringify(details, null, 2)} label="元数据" />
              </div>
              <pre className="max-h-52 overflow-auto rounded-[10px] border border-border/60 bg-muted/40 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground/85">
                {JSON.stringify(details, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 bg-muted/40 px-6 py-3.5">
          <span className="text-[11px] text-muted-foreground">
            审计记录为只读，不可编辑
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
