import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { DailyActivityItem } from "@/types/browser-activity";
import { formatDuration } from "@/lib/utils";
import { CalendarDays } from "lucide-react";

/**
 * 「按天汇总」视图：一行 = 用户 × 设备 × 平台 × 自然日。
 * 计数是当天该维度下全部会话的总和；要看单次会话与页面地址，切回会话明细。
 */
export function DailyTable({
  rows,
  isLoading,
}: {
  rows: DailyActivityItem[];
  isLoading?: boolean;
}) {
  if (rows.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border rounded-xl bg-card">
        <h3 className="text-sm font-semibold text-foreground">暂无符合条件的汇总记录</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          桌面端打开内置浏览器并产生交互后，按天聚合的活动汇总在此呈现
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <Table className="w-full min-w-[1020px]">
        <TableHeader>
          <TableRow className="hover:bg-muted/40">
            <TableHead className="w-[110px] min-w-[105px] p-2 py-2.5 text-center whitespace-nowrap">日期</TableHead>
            <TableHead className="w-[96px] min-w-[92px] p-2 py-2.5 text-center whitespace-nowrap">用户</TableHead>
            <TableHead className="w-[130px] min-w-[125px] p-2 py-2.5 text-center whitespace-nowrap">设备</TableHead>
            <TableHead className="w-[78px] min-w-[72px] p-2 py-2.5 text-center whitespace-nowrap">平台</TableHead>
            <TableHead className="w-[70px] min-w-[66px] p-2 py-2.5 text-center whitespace-nowrap">会话数</TableHead>
            <TableHead className="w-[72px] min-w-[68px] p-2 py-2.5 text-center whitespace-nowrap">访问地址</TableHead>
            <TableHead className="w-[215px] min-w-[210px] p-2 py-2.5 text-center whitespace-nowrap">交互统计</TableHead>
            <TableHead className="w-[76px] min-w-[72px] p-2 py-2.5 text-center whitespace-nowrap">前台停留</TableHead>
            <TableHead className="w-[138px] min-w-[135px] p-1.5 py-2.5 text-center whitespace-nowrap">首次活动</TableHead>
            <TableHead className="w-[138px] min-w-[135px] p-1.5 py-2.5 text-center whitespace-nowrap">最近上报</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.date}-${row.userId}-${row.deviceId ?? "unknown"}-${row.platformId}`} className="hover:bg-muted/40 transition-colors text-xs">
              {/* 日期 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5">
                <div className="flex items-center justify-center gap-1 whitespace-nowrap font-medium text-foreground">
                  <CalendarDays className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span>{row.date}</span>
                </div>
              </TableCell>

              {/* 用户 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5 font-semibold text-foreground">
                {row.username}
              </TableCell>

              {/* 设备 */}
              <TableCell className="text-center font-mono text-muted-foreground whitespace-nowrap p-2 py-2.5 text-[11px]">
                {row.deviceId ? (
                  <span title={row.deviceId}>
                    {row.deviceId.length > 16 ? `…${row.deviceId.slice(-12)}` : row.deviceId}
                  </span>
                ) : (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 text-muted-foreground bg-muted/40 border-border/70">
                    未知设备
                  </Badge>
                )}
              </TableCell>

              {/* 平台 */}
              <TableCell className="text-center text-foreground whitespace-nowrap p-2 py-2.5">
                {row.platformName || `平台 #${row.platformId}`}
              </TableCell>

              {/* 会话数 */}
              <TableCell className="text-center text-foreground whitespace-nowrap p-2 py-2.5">
                {row.sessions}
              </TableCell>

              {/* 访问地址 */}
              <TableCell className="text-center whitespace-nowrap p-2 py-2.5 font-semibold text-foreground">
                {row.pageCount}
              </TableCell>

              {/* 交互统计：单行不换行展示 */}
              <TableCell className="text-center text-muted-foreground whitespace-nowrap p-2 py-2.5">
                <div className="flex items-center justify-center gap-1 whitespace-nowrap text-xs">
                  <span>访问 <strong className="text-foreground">{row.visits}</strong></span>
                  <span className="text-border">·</span>
                  <span>点击 <strong className="text-foreground">{row.clicks}</strong></span>
                  <span className="text-border">·</span>
                  <span>输入 <strong className="text-foreground">{row.inputs}</strong></span>
                  <span className="text-border">·</span>
                  <span>提交 <strong className="text-foreground">{row.submits}</strong></span>
                  <span className="text-border">·</span>
                  <span>滚动 <strong className="text-foreground">{row.scrolls}</strong></span>
                </div>
              </TableCell>

              {/* 前台停留 */}
              <TableCell className="text-center text-foreground whitespace-nowrap font-medium p-2 py-2.5">
                {formatDuration(row.dwellMs)}
              </TableCell>

              {/* 首次活动 / 最近上报：展示当天活动的时间范围 */}
              <TableCell className="text-center font-mono text-muted-foreground whitespace-nowrap p-1.5 py-2.5 text-xs">
                {row.firstAt?.replace("T", " ").slice(0, 19) || "—"}
              </TableCell>
              <TableCell className="text-center font-mono text-muted-foreground whitespace-nowrap p-1.5 py-2.5 text-xs">
                {row.lastAt?.replace("T", " ").slice(0, 19) || "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
