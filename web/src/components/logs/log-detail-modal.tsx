import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UserLogItem } from "@/types/log";
import { formatDate } from "@/lib/utils";
import { FileText, CheckCircle, XCircle } from "lucide-react";

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

export function LogDetailModal({
  open,
  onOpenChange,
  log,
}: LogDetailModalProps) {
  if (!log) return null;
  const details = getLogDetails(log);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="h-5 w-5 text-primary" />
            <DialogTitle>审计日志详情 #{log.id}</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            系统与桌面端操作安全审计全链路追踪记录
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          {/* Status & Summary */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2">
              {log.status === "SUCCESS" ? (
                <Badge variant="success" className="gap-1 text-xs">
                  <CheckCircle className="h-3.5 w-3.5" />
                  <span>执行成功</span>
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1 text-xs">
                  <XCircle className="h-3.5 w-3.5" />
                  <span>执行失败</span>
                </Badge>
              )}
              <span className="font-semibold text-foreground text-sm">
                {log.action}
              </span>
            </div>
            <span className="text-muted-foreground">{formatDate(log.createdAt)}</span>
          </div>

          {/* Key Properties Grid */}
          <div className="grid grid-cols-2 gap-3 p-3 rounded-lg border">
            <div>
              <span className="text-muted-foreground block mb-0.5">操作人主体</span>
              <span className="font-semibold text-foreground">
                {log.actorUsername || "系统内部"}
              </span>
              <span className="text-[11px] text-muted-foreground ml-1.5">
                ({log.actorType} · {log.actorRole || "none"})
              </span>
            </div>

            <div>
              <span className="text-muted-foreground block mb-0.5">来源 IP 地址</span>
              <span className="font-mono text-foreground">
                {log.ipAddress || "—"}
              </span>
            </div>

            <div>
              <span className="text-muted-foreground block mb-0.5">关联目标对象</span>
              <span className="font-medium text-foreground">
                {log.targetType ? `${log.targetType}: ${log.targetName || log.targetId || "—"}` : "全局动作"}
              </span>
            </div>

            <div>
              <span className="text-muted-foreground block mb-0.5">Request ID</span>
              <span className="font-mono text-foreground text-[11px] truncate block" title={log.requestId || ""}>
                {log.requestId || "—"}
              </span>
            </div>
          </div>

          {/* Action Summary */}
          <div className="space-y-1">
            <span className="font-semibold text-muted-foreground block">操作摘要说明</span>
            <div className="p-3 rounded-lg border bg-card font-medium text-foreground">
              {log.summary || "无摘要说明"}
            </div>
          </div>

          {/* User Agent */}
          {log.userAgent && (
            <div className="space-y-1">
              <span className="font-semibold text-muted-foreground block">客户端 User-Agent</span>
              <div className="p-2.5 rounded-lg border bg-muted/20 font-mono text-[11px] text-muted-foreground break-all">
                {log.userAgent}
              </div>
            </div>
          )}

          {/* Detailed Payload (if any) */}
          {details && (
            <div className="space-y-1">
              <span className="font-semibold text-muted-foreground block">结构化元数据 (Details)</span>
              <pre className="p-3 rounded-lg border bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto max-h-48">
                {JSON.stringify(details, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
