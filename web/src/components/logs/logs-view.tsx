import { useState } from "react";
import { LogTable } from "./log-table";
import { LogDetailModal } from "./log-detail-modal";
import { UserLogItem } from "@/types/log";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  RefreshCw,
  FileJson,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { exportToJsonFile, exportToCsvFile } from "@/lib/export-utils";
import { getPageItems } from "@/lib/pagination";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface LogsViewProps {
  logs: UserLogItem[];
  totalLogs: number;
  currentPage: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  statusFilter: string;
  onStatusFilterChange: (val: string) => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
}

export function LogsView({
  logs,
  totalLogs,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
  statusFilter,
  onStatusFilterChange,
  onRefresh,
  isRefreshing,
}: LogsViewProps) {
  const [selectedLog, setSelectedLog] = useState<UserLogItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingJson, setIsExportingJson] = useState(false);

  const handleViewDetail = (log: UserLogItem) => {
    setSelectedLog(log);
    setDetailOpen(true);
  };

  const handleExportJson = async () => {
    if (totalLogs === 0 && logs.length === 0) {
      toast.warning("当前列表无数据可导出");
      return;
    }
    try {
      setIsExportingJson(true);
      const allLogs =
        logs.length === totalLogs && currentPage === 1
          ? logs
          : await api.fetchAllLogs({ status: statusFilter === "ALL" ? undefined : statusFilter });

      if (allLogs.length === 0) {
        toast.warning("未检索到可导出的数据");
        return;
      }
      exportToJsonFile(allLogs, `vestus-audit-logs-all-${new Date().toISOString().slice(0, 10)}.json`);
      toast.success(`已导出全部 ${allLogs.length} 条审计日志 (JSON)`);
    } catch (err: any) {
      toast.error("导出 JSON 失败", { description: err.message });
    } finally {
      setIsExportingJson(false);
    }
  };

  const handleExportCsv = async () => {
    if (totalLogs === 0 && logs.length === 0) {
      toast.warning("当前列表无数据可导出");
      return;
    }
    try {
      setIsExportingCsv(true);
      const allLogs =
        logs.length === totalLogs && currentPage === 1
          ? logs
          : await api.fetchAllLogs({ status: statusFilter === "ALL" ? undefined : statusFilter });

      if (allLogs.length === 0) {
        toast.warning("未检索到可导出的数据");
        return;
      }
      const headers = [
        { label: "日志编号", key: "id" },
        { label: "操作时间", key: "createdAt" },
        { label: "主体类型", key: "actorType" },
        { label: "主体账号", key: "actorUsername" },
        { label: "主体角色", key: "actorRole" },
        { label: "动作类型", key: "action" },
        { label: "摘要说明", key: "summary" },
        { label: "来源IP", key: "ipAddress" },
        { label: "结果状态", key: "status" },
        { label: "请求ID", key: "requestId" },
      ];
      exportToCsvFile(headers, allLogs, `vestus-audit-logs-all-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success(`已导出全部 ${allLogs.length} 条审计日志 (CSV)`);
    } catch (err: any) {
      toast.error("导出 CSV 失败", { description: err.message });
    } finally {
      setIsExportingCsv(false);
    }
  };

  const totalPages = Math.ceil(totalLogs / pageSize) || 1;

  return (
    <div className="space-y-4 animate-in fade-in-50 duration-300">
      {/* Action and Filter Toolbar */}
      <Card className="border-border/80 shadow-xs">
        <CardContent className="p-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2.5">
            {/* Left Action Buttons */}
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

            {/* Right Filter */}
            <div className="flex flex-1 items-center justify-end">
              <div className="w-36 shrink-0">
                <Select
                  value={statusFilter}
                  onValueChange={onStatusFilterChange}
                >
                  <SelectTrigger className="h-8 text-xs rounded-md border-border/60 bg-background/80 shadow-none">
                    <SelectValue placeholder="全部结果" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部结果</SelectItem>
                    <SelectItem value="SUCCESS">执行成功 (SUCCESS)</SelectItem>
                    <SelectItem value="FAILED">执行失败 (FAILED)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Log Table */}
      <LogTable
        logs={logs}
        onViewDetail={handleViewDetail}
        isLoading={isRefreshing}
      />

      {/* Pagination Footer */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            第 <strong className="text-foreground">{currentPage}</strong> 页，共 <strong className="text-foreground">{totalPages}</strong> 页 · 共 <strong className="text-foreground">{totalLogs}</strong> 条记录
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

      {/* Detail Modal */}
      <LogDetailModal
        open={detailOpen}
        onOpenChange={setDetailOpen}
        log={selectedLog}
      />
    </div>
  );
}
