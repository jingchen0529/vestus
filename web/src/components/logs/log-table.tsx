import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UserLogItem } from "@/types/log";
import { formatDate } from "@/lib/utils";
import { Eye, CheckCircle2, XCircle, Clock } from "lucide-react";

interface LogTableProps {
  logs: UserLogItem[];
  onViewDetail: (log: UserLogItem) => void;
  isLoading?: boolean;
}

export function LogTable({ logs, onViewDetail, isLoading }: LogTableProps) {
  if (logs.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border rounded-xl bg-card">
        <h3 className="text-sm font-semibold text-foreground">暂无符合条件的审计日志</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          系统尚无相关安全操作事件或当前过滤条件下无记录
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[170px]">操作时间</TableHead>
            <TableHead className="w-[180px]">操作主体</TableHead>
            <TableHead className="w-[150px]">动作类型</TableHead>
            <TableHead>操作摘要说明</TableHead>
            <TableHead className="w-[140px]">客户端 IP</TableHead>
            <TableHead className="w-[90px]">结果</TableHead>
            <TableHead className="w-[80px] text-right">详情</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((log) => (
            <TableRow key={log.id} className="hover:bg-muted/40 transition-colors text-xs">
              {/* Time */}
              <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 shrink-0" />
                  <span>{formatDate(log.createdAt)}</span>
                </div>
              </TableCell>

              {/* Actor */}
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-semibold text-foreground">
                    {log.actorUsername || "系统内部"}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {log.actorType} {log.actorRole ? `· ${log.actorRole}` : ""}
                  </span>
                </div>
              </TableCell>

              {/* Action */}
              <TableCell>
                <Badge variant="outline" className="font-mono text-[10px] uppercase">
                  {log.action}
                </Badge>
              </TableCell>

              {/* Summary */}
              <TableCell className="font-medium text-foreground max-w-md truncate" title={log.summary}>
                {log.summary || "—"}
              </TableCell>

              {/* IP */}
              <TableCell className="font-mono text-muted-foreground">
                {log.ipAddress || "—"}
              </TableCell>

              {/* Status */}
              <TableCell className="whitespace-nowrap">
                {log.status === "SUCCESS" ? (
                  <Badge variant="success" className="gap-1 text-[10px] whitespace-nowrap">
                    <CheckCircle2 className="h-3 w-3" />
                    <span>成功</span>
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1 text-[10px] whitespace-nowrap">
                    <XCircle className="h-3 w-3" />
                    <span>失败</span>
                  </Badge>
                )}
              </TableCell>

              {/* Detail Button */}
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onViewDetail(log)}
                  className="h-7 w-7 text-muted-foreground hover:text-primary"
                  title="查看完整日志详情"
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
