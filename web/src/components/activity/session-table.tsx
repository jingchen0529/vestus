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
      <Table className="w-full min-w-[1020px]">
        <TableHeader>
          <TableRow className="hover:bg-muted/40">
            <TableHead className="w-[96px] min-w-[92px] p-2 py-2.5 text-center whitespace-nowrap">用户</TableHead>
            <TableHead className="w-[82px] min-w-[80px] p-2 py-2.5 text-center whitespace-nowrap">客户端版本</TableHead>
            <TableHead className="w-[78px] min-w-[72px] p-2 py-2.5 text-center whitespace-nowrap">平台</TableHead>
            <TableHead className="w-[72px] min-w-[68px] p-2 py-2.5 text-center whitespace-nowrap">连接方式</TableHead>
            <TableHead className="w-[72px] min-w-[68px] p-2 py-2.5 text-center whitespace-nowrap">访问地址</TableHead>
            <TableHead className="w-[215px] min-w-[210px] p-2 py-2.5 text-center whitespace-nowrap">交互统计</TableHead>
            <TableHead className="w-[76px] min-w-[72px] p-2 py-2.5 text-center whitespace-nowrap">前台停留</TableHead>
            <TableHead className="w-[105px] min-w-[100px] p-2 py-2.5 text-center whitespace-nowrap">客户端 IP</TableHead>
            <TableHead className="w-[138px] min-w-[135px] p-1.5 py-2.5 text-center whitespace-nowrap">会话时间</TableHead>
            <TableHead className="w-[125px] min-w-[120px] p-1.5 py-2.5 text-center whitespace-nowrap">上报时间</TableHead>
            <TableHead className="w-[68px] min-w-[65px] p-2 py-2.5 text-center whitespace-nowrap sticky right-0 bg-muted/95 backdrop-blur-xs z-10 shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.05)] border-l border-border/30">详情</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.id} className="group hover:bg-muted/40 transition-colors text-xs">
              {/* 用户 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5">
                <div className="flex items-center justify-center gap-1 whitespace-nowrap">
                  <span className="font-semibold text-foreground">
                    {session.username}
                  </span>
                </div>
              </TableCell>

              {/* 客户端版本 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5">
                <div className="flex justify-center whitespace-nowrap">
                  {session.clientVersion ? (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 font-mono text-primary bg-primary/5 border-primary/30">
                      v{session.clientVersion.replace(/^desktop-/, "").replace(/^v/, "")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 font-mono text-muted-foreground bg-muted/40 border-border/70">
                      v0.1.8
                    </Badge>
                  )}
                </div>
              </TableCell>

              {/* 平台 */}
              <TableCell className="text-center text-foreground whitespace-nowrap p-2 py-2.5">
                {session.platformName || `平台 #${session.platformId}`}
              </TableCell>

              {/* 连接方式 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5">
                <div className="flex justify-center whitespace-nowrap">
                  {session.directMode ? (
                    <Badge variant="warning" className="gap-1 text-[10px] px-1.5 py-0.5 whitespace-nowrap">
                      <Unplug className="h-3 w-3" />
                      <span>直连</span>
                    </Badge>
                  ) : (
                    <Badge variant="success" className="gap-1 text-[10px] px-1.5 py-0.5 whitespace-nowrap">
                      <Server className="h-3 w-3" />
                      <span>代理</span>
                    </Badge>
                  )}
                </div>
              </TableCell>

              {/* 访问地址 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5">
                <div className="flex items-center justify-center gap-1 whitespace-nowrap">
                  <span className="font-semibold text-foreground">{session.pageCount}</span>
                  {session.droppedPages > 0 && (
                    <Badge
                      variant="destructive"
                      className="gap-0.5 text-[10px] px-1 py-0 whitespace-nowrap"
                      title={`客户端聚合表溢出，另有 ${session.droppedPages} 个地址未被记录`}
                    >
                      <AlertTriangle className="h-2.5 w-2.5" />
                      <span>不完整</span>
                    </Badge>
                  )}
                </div>
              </TableCell>

              {/* 交互统计：单行不换行展示 */}
              <TableCell className="text-center text-muted-foreground whitespace-nowrap p-2 py-2.5">
                <div className="flex items-center justify-center gap-1 whitespace-nowrap text-xs">
                  <span>访问 <strong className="text-foreground">{session.visits}</strong></span>
                  <span className="text-border">·</span>
                  <span>点击 <strong className="text-foreground">{session.clicks}</strong></span>
                  <span className="text-border">·</span>
                  <span>输入 <strong className="text-foreground">{session.inputs}</strong></span>
                  <span className="text-border">·</span>
                  <span>提交 <strong className="text-foreground">{session.submits}</strong></span>
                  <span className="text-border">·</span>
                  <span>滚动 <strong className="text-foreground">{session.scrolls}</strong></span>
                </div>
              </TableCell>

              {/* 前台停留 */}
              <TableCell className="text-center text-foreground whitespace-nowrap font-medium p-2 py-2.5">
                {formatDuration(session.dwellMs)}
              </TableCell>

              {/* 客户端 IP */}
              <TableCell className="text-center font-mono text-muted-foreground whitespace-nowrap p-2 py-2.5 text-xs">
                {session.ipAddress || "—"}
              </TableCell>

              {/* 会话时间 (开始时间) */}
              <TableCell className="text-center font-mono text-muted-foreground whitespace-nowrap p-1.5 py-2.5 text-xs">
                <div className="flex items-center justify-center gap-1 whitespace-nowrap">
                  <Clock className="h-3 w-3 shrink-0" />
                  <span>{formatDate(session.startedAt)}</span>
                </div>
              </TableCell>

              {/* 上报时间 (最近上报) */}
              <TableCell className="text-center font-mono text-muted-foreground whitespace-nowrap p-1.5 py-2.5 text-xs">
                {formatDate(session.lastReportAt)}
              </TableCell>

              {/* 详情 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5 sticky right-0 bg-card group-hover:bg-muted/60 transition-colors z-10 shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.05)] border-l border-border/30">
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onViewDetail(session)}
                    className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70 border border-border/40 hover:border-border/70 shadow-none font-normal transition-colors"
                  >
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>查看</span>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
