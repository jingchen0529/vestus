import { useCallback, useEffect, useState } from "react";
import { SessionTable } from "./session-table";
import { DailyTable } from "./daily-table";
import { SessionDetailModal } from "./session-detail-modal";
import {
  BrowserSessionDetail,
  BrowserSessionFilters,
  BrowserSessionItem,
  DailyActivityItem,
  toBrowserSessionQuery,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DataCard,
  PageToolbar,
  PageToolbarActions,
} from "@/components/ui/page-toolbar";
import { TablePagination } from "@/components/ui/table-pagination";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  RefreshCw,
  FileJson,
  FileSpreadsheet,
  Download,
  ChevronDown,
  RotateCcw,
} from "lucide-react";
import { exportToJsonFile, exportToCsvFile, withBeijingDateTimes } from "@/lib/export-utils";
import { beijingDateStamp, formatBeijingDateTime } from "@/lib/utils";
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
  const [isExportingAdvids, setIsExportingAdvids] = useState(false);

  // 「按天汇总」视图的数据由本组件自己取：它和会话明细共用筛选，但分页独立。
  const [viewMode, setViewMode] = useState<"sessions" | "daily">("sessions");
  const [dailyRows, setDailyRows] = useState<DailyActivityItem[]>([]);
  const [totalDaily, setTotalDaily] = useState(0);
  const [dailyPage, setDailyPage] = useState(1);
  const [isDailyLoading, setIsDailyLoading] = useState(false);

  const loadDaily = useCallback(
    async (page: number) => {
      try {
        setIsDailyLoading(true);
        const res = await api.listDailyActivity({
          ...toBrowserSessionQuery(filters),
          page,
          pageSize,
        });
        setDailyRows(res.items);
        setTotalDaily(res.total);
      } catch (err: any) {
        toast.error("加载按天汇总失败", { description: err.message });
      } finally {
        setIsDailyLoading(false);
      }
    },
    [filters, pageSize],
  );

  // 筛选变了，汇总的页码跟着归位，再由下面的 effect 重新取数。
  useEffect(() => {
    setDailyPage(1);
  }, [filters, pageSize]);

  useEffect(() => {
    if (viewMode === "daily") {
      void loadDaily(dailyPage);
    }
  }, [viewMode, dailyPage, loadDaily]);

  const handleViewModeChange = (mode: string) => {
    setViewMode(mode === "daily" ? "daily" : "sessions");
    setDailyPage(1);
  };

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
        withBeijingDateTimes(allSessions, ["startedAt", "lastReportAt"]),
        `vestus-browser-sessions-all-${beijingDateStamp()}.json`,
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
        { label: "开始时间", key: "startedAt", format: formatBeijingDateTime },
        { label: "最近上报", key: "lastReportAt", format: formatBeijingDateTime },
        { label: "桌面用户", key: "username" },
        { label: "平台名称", key: "platformName" },
        { label: "托管账号", key: "managedAccountName" },
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
        `vestus-browser-sessions-all-${beijingDateStamp()}.csv`,
      );
      toast.success(`已导出全部 ${rows.length} 条会话追踪记录 (CSV)`);
    } catch (err: any) {
      toast.error("导出 CSV 失败", { description: err.message });
    } finally {
      setIsExportingCsv(false);
    }
  };

  const handleExportAdvids = async (valuesOnly: boolean = false) => {
    try {
      setIsExportingAdvids(true);
      const query = toBrowserSessionQuery(filters);
      const res = await api.exportAdvids({
        param: "advid",
        userId: query.userId,
        platformId: query.platformId,
        directMode: query.directMode,
        startAt: query.startAt,
        endAt: query.endAt,
      });

      if (!res.items || res.items.length === 0) {
        toast.warning("当前筛选条件下未检索到相关的 ID 数据");
        return;
      }

      const datePart =
        filters.startAt || filters.endAt
          ? `${filters.startAt || "start"}_${filters.endAt || "end"}`
          : "all";
      const filename = `vestus-advid-unique-${datePart}-${beijingDateStamp()}.csv`;

      if (valuesOnly) {
        const headers = [{ label: res.param || "advid", key: "paramValue" }];
        exportToCsvFile(headers, res.items, filename);
      } else {
        const headers = [
          { label: "ID (" + (res.param || "advid") + ")", key: "paramValue" },
          { label: "出现次数", key: "occurrences" },
          { label: "累计访问量", key: "totalVisits" },
          { label: "首次访问时间", key: "firstSeenAt", format: formatBeijingDateTime },
          { label: "最后访问时间", key: "lastSeenAt", format: formatBeijingDateTime },
          { label: "关联桌面用户", key: "usernames" },
          { label: "关联平台", key: "platforms" },
        ];
        exportToCsvFile(headers, res.items, filename);
      }

      toast.success(`已导出去重后的 ${res.items.length} 个 ID 记录 (CSV)`);
    } catch (err: any) {
      toast.error("导出 ID 失败", { description: err.message });
    } finally {
      setIsExportingAdvids(false);
    }
  };

  const totalPages = Math.ceil(totalSessions / pageSize) || 1;
  const displayTotal = viewMode === "daily" ? totalDaily : totalSessions;
  const displayTotalPages = Math.ceil(displayTotal / pageSize) || 1;

  const handleExportDailyCsv = async () => {
    if (dailyRows.length === 0 && totalDaily === 0) {
      toast.warning("当前筛选条件下无数据可导出");
      return;
    }
    try {
      setIsExportingCsv(true);
      const allRows =
        dailyRows.length === totalDaily && dailyPage === 1
          ? dailyRows
          : await api.fetchAllDailyActivity(filters);
      if (allRows.length === 0) {
        toast.warning("未检索到可导出的数据");
        return;
      }
      const headers = [
        { label: "日期", key: "date" },
        { label: "桌面用户", key: "username" },
        { label: "设备标识", key: "deviceId" },
        { label: "平台名称", key: "platformName" },
        { label: "托管账号", key: "managedAccountName" },
        { label: "会话数", key: "sessions" },
        { label: "访问地址数", key: "pageCount" },
        { label: "访问次数", key: "visits" },
        { label: "点击次数", key: "clicks" },
        { label: "输入次数", key: "inputs" },
        { label: "提交次数", key: "submits" },
        { label: "滚动次数", key: "scrolls" },
        { label: "前台停留(毫秒)", key: "dwellMs" },
        { label: "首次活动", key: "firstAt", format: formatBeijingDateTime },
        { label: "最近上报", key: "lastAt", format: formatBeijingDateTime },
      ];
      exportToCsvFile(
        headers,
        allRows,
        `vestus-browser-daily-${beijingDateStamp()}.csv`,
      );
      toast.success(`已导出全部 ${allRows.length} 条按天汇总记录 (CSV)`);
    } catch (err: any) {
      toast.error("导出 CSV 失败", { description: err.message });
    } finally {
      setIsExportingCsv(false);
    }
  };

  const handleExportDailyJson = async () => {
    if (dailyRows.length === 0 && totalDaily === 0) {
      toast.warning("当前筛选条件下无数据可导出");
      return;
    }
    try {
      setIsExportingJson(true);
      const allRows =
        dailyRows.length === totalDaily && dailyPage === 1
          ? dailyRows
          : await api.fetchAllDailyActivity(filters);
      if (allRows.length === 0) {
        toast.warning("未检索到可导出的数据");
        return;
      }
      exportToJsonFile(
        withBeijingDateTimes(allRows, ["firstAt", "lastAt"]),
        `vestus-browser-daily-${beijingDateStamp()}.json`,
      );
      toast.success(`已导出全部 ${allRows.length} 条按天汇总记录 (JSON)`);
    } catch (err: any) {
      toast.error("导出 JSON 失败", { description: err.message });
    } finally {
      setIsExportingJson(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-300">
      <DataCard>
        {/* 顶栏：左侧切换「会话明细 / 按天汇总」视图，右侧统一放置刷新与导出动作 */}
        <PageToolbar>
          <Tabs value={viewMode} onValueChange={handleViewModeChange}>
            <TabsList className="h-8">
              <TabsTrigger value="sessions" className="text-xs px-3 h-7">
                会话明细
              </TabsTrigger>
              <TabsTrigger value="daily" className="text-xs px-3 h-7">
                按天汇总
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <PageToolbarActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() => (viewMode === "daily" ? loadDaily(dailyPage) : onRefresh())}
              disabled={isRefreshing || isDailyLoading}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 text-muted-foreground ${
                  (viewMode === "daily" ? isDailyLoading : isRefreshing) ? "animate-spin" : ""
                }`}
              />
              <span>刷新</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={viewMode === "daily" ? handleExportDailyCsv : handleExportCsv}
              disabled={isExportingCsv || isRefreshing || isDailyLoading}
            >
              <FileSpreadsheet
                className={`h-3.5 w-3.5 text-emerald-600 ${isExportingCsv ? "animate-spin" : ""}`}
              />
              <span>{isExportingCsv ? "正在导出..." : "导出 CSV"}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={viewMode === "daily" ? handleExportDailyJson : handleExportJson}
              disabled={isExportingJson || isRefreshing || isDailyLoading}
            >
              <FileJson
                className={`h-3.5 w-3.5 text-blue-600 ${isExportingJson ? "animate-spin" : ""}`}
              />
              <span>{isExportingJson ? "正在导出..." : "导出 JSON"}</span>
            </Button>

            {/* 去重 ID 导出只对明细有意义：按天行里没有地址参数 */}
            {viewMode === "sessions" && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isExportingAdvids || isRefreshing}
                    className="whitespace-nowrap shrink-0"
                  >
                    <Download
                      className={`h-3.5 w-3.5 text-indigo-600 shrink-0 ${
                        isExportingAdvids ? "animate-spin" : ""
                      }`}
                    />
                    <span className="whitespace-nowrap">
                      {isExportingAdvids ? "正在导出 ID..." : "导出 ID (去重)"}
                    </span>
                    <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-auto min-w-[220px] text-xs whitespace-nowrap p-1"
                >
                  <DropdownMenuItem
                    onClick={() => handleExportAdvids(false)}
                    className="cursor-pointer whitespace-nowrap flex items-center py-2 px-3"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600 mr-2 shrink-0" />
                    <span className="whitespace-nowrap">导出去重 ID 汇总表 (CSV)</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExportAdvids(true)}
                    className="cursor-pointer whitespace-nowrap flex items-center py-2 px-3"
                  >
                    <Download className="h-3.5 w-3.5 text-indigo-600 mr-2 shrink-0" />
                    <span className="whitespace-nowrap">仅导出纯 ID 列表 (CSV)</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </PageToolbarActions>
        </PageToolbar>

        {/* 二级筛选栏：多维过滤条件独立成行，避免与左侧导出按钮在中屏下互相挤压 */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-border/60 bg-muted/5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-36">
              <Select
                value={filters.userId}
                onValueChange={(value) => patchFilters({ userId: value })}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部桌面用户" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部桌面用户</SelectItem>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={String(user.id)} className="text-xs">
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
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部平台" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部平台</SelectItem>
                  {platforms.map((platform) => (
                    <SelectItem key={platform.id} value={String(platform.id)} className="text-xs">
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
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部连接方式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部连接方式</SelectItem>
                  <SelectItem value="PROXY" className="text-xs">代理</SelectItem>
                  <SelectItem value="DIRECT" className="text-xs">直连</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="w-[140px]">
              <DatePicker
                size="sm"
                value={filters.startAt}
                max={filters.endAt || undefined}
                onChange={(value) => patchFilters({ startAt: value })}
                placeholder="起始日期"
                title="按会话开始时间筛选：起始日期"
              />
            </div>

            <div className="w-[140px]">
              <DatePicker
                size="sm"
                value={filters.endAt}
                min={filters.startAt || undefined}
                onChange={(value) => patchFilters({ endAt: value })}
                placeholder="结束日期"
                title="按会话开始时间筛选：结束日期（含当天）"
              />
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleResetFilters}
            disabled={!hasActiveFilters || isRefreshing}
            className="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-40"
            title="清空所有筛选条件"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>重置</span>
          </Button>
        </div>

        {viewMode === "sessions" ? (
          <SessionTable
            sessions={sessions}
            onViewDetail={handleViewDetail}
            isLoading={isRefreshing}
            embedded
          />
        ) : (
          <DailyTable rows={dailyRows} isLoading={isDailyLoading} embedded />
        )}

        <TablePagination
          currentPage={viewMode === "daily" ? dailyPage : currentPage}
          totalPages={viewMode === "daily" ? displayTotalPages : totalPages}
          totalItems={displayTotal}
          pageSize={pageSize}
          onPageChange={(page) =>
            viewMode === "daily" ? setDailyPage(page) : onPageChange(page)
          }
          onPageSizeChange={onPageSizeChange}
          disabled={isRefreshing || isDailyLoading}
        />
      </DataCard>

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
