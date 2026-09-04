import { useState } from "react";
import { SessionTable } from "./session-table";
import { SessionDetailModal } from "./session-detail-modal";
import {
  BrowserSessionDetail,
  BrowserSessionFilters,
  BrowserSessionItem,
} from "@/types/browser-activity";
import { DesktopUser } from "@/types/user";
import { PlatformItem } from "@/types/platform";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  RefreshCw,
  FileJson,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  RotateCcw,
} from "lucide-react";
import { exportToJsonFile, exportToCsvFile } from "@/lib/export-utils";
import { getPageItems } from "@/lib/pagination";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface ActivityViewProps {
  sessions: BrowserSessionItem[];
  totalSessions: number;
  currentPage: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  filters: BrowserSessionFilters;
  onFiltersChange: (filters: BrowserSessionFilters) => void;
  /** 用来把筛选下拉填成人看得懂的名字，而不是让人记 ID。 */
  users: DesktopUser[];
  platforms: PlatformItem[];
  onRefresh: () => void;
  isRefreshing?: boolean;
  onLoadDetail: (id: number) => Promise<BrowserSessionDetail>;
}

export function ActivityView({
  sessions,
  totalSessions,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
  filters,
  onFiltersChange,
  users,
  platforms,
  onRefresh,
  isRefreshing,
  onLoadDetail,
}: ActivityViewProps) {
  const [selectedSession, setSelectedSession] = useState<BrowserSessionItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingJson, setIsExportingJson] = useState(false);

  const handleViewDetail = (session: BrowserSessionItem) => {
    setSelectedSession(session);
    setDetailOpen(true);
  };

  const patchFilters = (patch: Partial<BrowserSessionFilters>) => {
    onFiltersChange({ ...filters, ...patch });
  };

  const hasActiveFilters =
    filters.userId !== "ALL" ||
    filters.platformId !== "ALL" ||
    filters.connection !== "ALL" ||
    Boolean(filters.startAt) ||
    Boolean(filters.endAt);

  const handleResetFilters = () => {
    onFiltersChange({
      userId: "ALL",
      platformId: "ALL",
      connection: "ALL",
      startAt: "",
      endAt: "",
    });
    toast.success("已重置所有筛选条件");
  };

  const handleExportJson = async () => {
    if (totalSessions === 0 && sessions.length === 0) {
      toast.warning("当前筛选条件下无数据可导出");
      return;
    }
    try {
      setIsExportingJson(true);
      const allSessions =
        sessions.length === totalSessions && currentPage === 1
          ? sessions
          : await api.fetchAllBrowserSessions(filters);

      if (allSessions.length === 0) {
        toast.warning("未检索到可导出的数据");
        return;
      }

      exportToJsonFile(
        allSessions,
        `vestus-browser-sessions-all-${new Date().toISOString().slice(0, 10)}.json`,
      );
      toast.success(`已导出全部 ${allSessions.length} 条会话追踪记录 (JSON)`);
    } catch (err: any) {
      toast.error("导出 JSON 失败", { description: err.message });
    } finally {
      setIsExportingJson(false);
    }
  };

  const handleExportCsv = async () => {
    if (totalSessions === 0 && sessions.length === 0) {
      toast.warning("当前筛选条件下无数据可导出");
      return;
    }
    try {
      setIsExportingCsv(true);
      const allSessions =
        sessions.length === totalSessions && currentPage === 1
          ? sessions
          : await api.fetchAllBrowserSessions(filters);

      if (allSessions.length === 0) {
        toast.warning("未检索到可导出的数据");
        return;
      }

      const headers = [
        { label: "会话编号", key: "id" },
        { label: "开始时间", key: "startedAt" },
        { label: "最近上报", key: "lastReportAt" },
        { label: "桌面用户", key: "username" },
        { label: "平台名称", key: "platformName" },
        { label: "连接方式", key: "connectionText" },
        { label: "访问地址数", key: "pageCount" },
        { label: "未记录地址数", key: "droppedPages" },
        { label: "访问次数", key: "visits" },
        { label: "点击次数", key: "clicks" },
        { label: "输入次数", key: "inputs" },
        { label: "提交次数", key: "submits" },
        { label: "滚动次数", key: "scrolls" },
        { label: "前台停留(毫秒)", key: "dwellMs" },
        { label: "客户端IP", key: "ipAddress" },
      ];

      const rows = allSessions.map((s) => ({
        ...s,
        connectionText: s.directMode ? "直连" : "代理",
        directMode: s.directMode ? "直连" : "代理",
      }));

      exportToCsvFile(
        headers,
        rows,
        `vestus-browser-sessions-all-${new Date().toISOString().slice(0, 10)}.csv`,
      );
      toast.success(`已导出全部 ${rows.length} 条会话追踪记录 (CSV)`);
    } catch (err: any) {
      toast.error("导出 CSV 失败", { description: err.message });
    } finally {
      setIsExportingCsv(false);
    }
  };

  const totalPages = Math.ceil(totalSessions / pageSize) || 1;

  return (
    <div className="space-y-4 animate-in fade-in-50 duration-300">
      {/* 工具条 */}
      <Card className="border-border/80 shadow-xs">
        <CardContent className="p-3">
          <div className="flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-2.5">
            {/* 左侧操作按钮 */}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRefresh()}
                disabled={isRefreshing}
                className="h-8 gap-1.5 px-2.5 text-xs rounded-md border-border/60 bg-background/80 hover:bg-muted text-foreground shadow-none font-normal transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`} />
                <span>刷新</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleExportCsv}
                disabled={isExportingCsv || isRefreshing}
                className="h-8 gap-1.5 px-2.5 text-xs rounded-md border-border/60 bg-background/80 hover:bg-muted text-foreground shadow-none font-normal transition-colors"
              >
                <FileSpreadsheet className={`h-3.5 w-3.5 text-emerald-600 ${isExportingCsv ? "animate-spin" : ""}`} />
                <span>{isExportingCsv ? "正在导出..." : "导出 CSV"}</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleExportJson}
                disabled={isExportingJson || isRefreshing}
                className="h-8 gap-1.5 px-2.5 text-xs rounded-md border-border/60 bg-background/80 hover:bg-muted text-foreground shadow-none font-normal transition-colors"
              >
                <FileJson className={`h-3.5 w-3.5 text-blue-600 ${isExportingJson ? "animate-spin" : ""}`} />
                <span>{isExportingJson ? "正在导出..." : "导出 JSON"}</span>
              </Button>
            </div>

            {/* 右侧筛选条件 单行排列 */}
            <div className="flex flex-wrap items-center gap-2 shrink-0 justify-start xl:justify-end">
              <div className="w-36">
                <Select
                  value={filters.userId}
                  onValueChange={(value) => patchFilters({ userId: value })}
                >
                  <SelectTrigger className="h-8 text-xs rounded-md border-border/60 shadow-none bg-background/80">
                    <SelectValue placeholder="全部桌面用户" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部桌面用户</SelectItem>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={String(user.id)}>
                        {user.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-36">
                <Select
                  value={filters.platformId}
                  onValueChange={(value) => patchFilters({ platformId: value })}
                >
                  <SelectTrigger className="h-8 text-xs rounded-md border-border/60 shadow-none bg-background/80">
                    <SelectValue placeholder="全部平台" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部平台</SelectItem>
                    {platforms.map((platform) => (
                      <SelectItem key={platform.id} value={String(platform.id)}>
                        {platform.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-32">
                <Select
                  value={filters.connection}
                  onValueChange={(value) =>
                    patchFilters({ connection: value as BrowserSessionFilters["connection"] })
                  }
                >
                  <SelectTrigger className="h-8 text-xs rounded-md border-border/60 shadow-none bg-background/80">
                    <SelectValue placeholder="全部连接方式" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部连接方式</SelectItem>
                    <SelectItem value="PROXY">代理</SelectItem>
                    <SelectItem value="DIRECT">直连</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-[140px]">
                <DatePicker
                  value={filters.startAt}
                  max={filters.endAt || undefined}
                  onChange={(value) => patchFilters({ startAt: value })}
                  placeholder="起始日期"
                  title="按会话开始时间筛选：起始日期"
                />
              </div>

              <div className="w-[140px]">
                <DatePicker
                  value={filters.endAt}
                  min={filters.startAt || undefined}
                  onChange={(value) => patchFilters({ endAt: value })}
                  placeholder="结束日期"
                  title="按会话开始时间筛选：结束日期（含当天）"
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={handleResetFilters}
                disabled={!hasActiveFilters || isRefreshing}
                className="h-8 gap-1.5 px-2.5 text-xs rounded-md border-border/60 bg-background/80 hover:bg-muted text-muted-foreground hover:text-foreground shadow-none font-normal transition-colors shrink-0 disabled:opacity-40"
                title="清空所有筛选条件"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>重置</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <SessionTable
        sessions={sessions}
        onViewDetail={handleViewDetail}
        isLoading={isRefreshing}
      />

      {/* 分页 */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            第 <strong className="text-foreground">{currentPage}</strong> 页，共 <strong className="text-foreground">{totalPages}</strong> 页 · 共 <strong className="text-foreground">{totalSessions}</strong> 条记录
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">每页</span>
            <Select
              value={String(pageSize)}
              onValueChange={(val) => onPageSizeChange?.(Number(val))}
            >
              <SelectTrigger className="h-7 w-[78px] text-xs rounded-md border-border/60 bg-background/80 shadow-none px-2">
                <SelectValue placeholder={`${pageSize} 条`}>{`${pageSize} 条`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 条</SelectItem>
                <SelectItem value="30">30 条</SelectItem>
                <SelectItem value="50">50 条</SelectItem>
                <SelectItem value="100">100 条</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(1)}
            disabled={currentPage <= 1 || isRefreshing}
            className="h-8 w-8 p-0 text-xs rounded-md border-border/60"
            title="第一页"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1 || isRefreshing}
            className="h-8 w-8 p-0 text-xs rounded-md border-border/60"
            title="上一页"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>

          {getPageItems(currentPage, totalPages).map((item, idx) => {
            if (typeof item === "string") {
              return (
                <span
                  key={`ellipsis-${idx}`}
                  className="px-1 text-xs text-muted-foreground/80 select-none flex items-center justify-center min-w-[1.25rem]"
                >
                  ...
                </span>
              );
            }
            const isCurrent = item === currentPage;
            return (
              <Button
                key={item}
                variant={isCurrent ? "default" : "outline"}
                size="sm"
                onClick={() => onPageChange(item)}
                disabled={isRefreshing}
                className={`h-8 min-w-[2rem] px-2 text-xs rounded-md ${
                  isCurrent
                    ? "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 font-semibold shadow-xs"
                    : "border-border/60 bg-background/80 hover:bg-muted text-foreground font-normal"
                }`}
              >
                {item}
              </Button>
            );
          })}

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || isRefreshing}
            className="h-8 w-8 p-0 text-xs rounded-md border-border/60"
            title="下一页"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(totalPages)}
            disabled={currentPage >= totalPages || isRefreshing}
            className="h-8 w-8 p-0 text-xs rounded-md border-border/60"
            title="最后一页"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <SessionDetailModal
        open={detailOpen}
        onOpenChange={setDetailOpen}
        session={selectedSession}
        onLoadDetail={onLoadDetail}
        onRefreshSessions={onRefresh}
      />
    </div>
  );
}
