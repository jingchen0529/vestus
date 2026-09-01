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
import { BrowserSessionItem } from "@/types/browser-activity";
import { formatDate, formatDuration } from "@/lib/utils";
import { Eye, Clock, AlertTriangle, Server, Unplug } from "lucide-react";

interface SessionTableProps {
  sessions: BrowserSessionItem[];
  onViewDetail: (session: BrowserSessionItem) => void;
  isLoading?: boolean;
}

export function SessionTable({ sessions, onViewDetail, isLoading }: SessionTableProps) {
  if (sessions.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border rounded-xl bg-card">
        <h3 className="text-sm font-semibold text-foreground">暂无符合条件的会话追踪记录</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          桌面端打开内置浏览器并产生交互后，会话数据与访问明细会在此实时呈现
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">会话时间</TableHead>
            <TableHead className="w-[160px]">桌面用户</TableHead>
            <TableHead className="w-[150px]">平台</TableHead>
            <TableHead className="w-[110px]">连接方式</TableHead>
            <TableHead className="w-[110px]">访问地址</TableHead>
            <TableHead>交互统计</TableHead>
            <TableHead className="w-[120px]">前台停留</TableHead>
            <TableHead className="w-[130px]">客户端 IP</TableHead>
            <TableHead className="w-[80px] text-right">详情</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.id} className="hover:bg-muted/40 transition-colors text-xs">
              {/* 开始时间在上，最近一次上报在下——两个时间放一格，表格才不至于太宽 */}
              <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 shrink-0" />
                  <span>{formatDate(session.startedAt)}</span>
                </div>
                <span className="text-[10px] pl-[18px]">
                  最近上报 {formatDate(session.lastReportAt)}
                </span>
              </TableCell>

              <TableCell>
                <div className="flex flex-col">
                  <span className="font-semibold text-foreground">
                    {session.username || `#${session.userId}`}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    浏览器 #{session.browserId}
                  </span>
                </div>
              </TableCell>

              <TableCell className="text-foreground">
                {session.platformName || `平台 #${session.platformId}`}
              </TableCell>

              <TableCell className="whitespace-nowrap">
                {session.directMode ? (
                  <Badge variant="warning" className="gap-1 text-[10px] whitespace-nowrap">
                    <Unplug className="h-3 w-3" />
                    <span>直连</span>
                  </Badge>
                ) : (
                  <Badge variant="success" className="gap-1 text-[10px] whitespace-nowrap">
                    <Server className="h-3 w-3" />
                    <span>走代理</span>
                  </Badge>
                )}
              </TableCell>

              <TableCell>
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-foreground">{session.pageCount}</span>
                  {session.droppedPages > 0 && (
                    <Badge
                      variant="destructive"
                      className="gap-1 text-[10px] whitespace-nowrap"
                      title={`客户端聚合表溢出，另有 ${session.droppedPages} 个地址未被记录`}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      <span>不完整</span>
                    </Badge>
                  )}
                </div>
              </TableCell>

              <TableCell className="text-muted-foreground whitespace-nowrap">
                <div>
                  访问 <strong className="text-foreground">{session.visits}</strong>
                  {" · "}点击 <strong className="text-foreground">{session.clicks}</strong>
                </div>
                <div className="text-[10px]">
                  输入 {session.inputs} · 提交 {session.submits} · 滚动 {session.scrolls}
                </div>
              </TableCell>

              <TableCell className="text-foreground whitespace-nowrap">
                {formatDuration(session.dwellMs)}
              </TableCell>

              <TableCell className="font-mono text-muted-foreground">
                {session.ipAddress || "—"}
              </TableCell>

              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onViewDetail(session)}
                  className="h-7 px-2.5 text-xs gap-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70 border border-border/40 hover:border-border/70 shadow-none font-normal transition-colors"
                >
                  <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>查看</span>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
