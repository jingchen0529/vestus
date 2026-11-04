import { useState } from "react";
import { LogTable } from "./log-table";
import { LogDetailModal } from "./log-detail-modal";
import { UserLogItem } from "@/types/log";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DataCard,
  PageToolbar,
  PageToolbarActions,
  PageToolbarFilters,
} from "@/components/ui/page-toolbar";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  RefreshCw,
  FileJson,
  FileSpreadsheet,
} from "lucide-react";
import { exportToJsonFile, exportToCsvFile, withBeijingDateTimes } from "@/lib/export-utils";
import { beijingDateStamp, formatBeijingDateTime } from "@/lib/utils";
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
      exportToJsonFile(
        withBeijingDateTimes(allLogs, ["createdAt"]),
        `vestus-audit-logs-all-${beijingDateStamp()}.json`,
      );
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
        { label: "操作时间", key: "createdAt", format: formatBeijingDateTime },
        { label: "主体类型", key: "actorType" },
        { label: "主体账号", key: "actorUsername" },
        { label: "主体角色", key: "actorRole" },
        { label: "动作类型", key: "action" },
        { label: "摘要说明", key: "summary" },
        { label: "来源IP", key: "ipAddress" },
        { label: "结果状态", key: "status" },
        { label: "请求ID", key: "requestId" },
      ];
      exportToCsvFile(headers, allLogs, `vestus-audit-logs-all-${beijingDateStamp()}.csv`);
      toast.success(`已导出全部 ${allLogs.length} 条审计日志 (CSV)`);
    } catch (err: any) {
      toast.error("导出 CSV 失败", { description: err.message });
    } finally {
      setIsExportingCsv(false);
    }
  };

  const totalPages = Math.ceil(totalLogs / pageSize) || 1;

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-300">
      <DataCard>
        <PageToolbar>
          <PageToolbarActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRefresh()}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`}
              />
              <span>刷新</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={isExportingCsv || isRefreshing}
            >
              <FileSpreadsheet
                className={`h-3.5 w-3.5 text-success ${isExportingCsv ? "animate-spin" : ""}`}
              />
              <span>{isExportingCsv ? "正在导出..." : "导出 CSV"}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportJson}
              disabled={isExportingJson || isRefreshing}
            >
              <FileJson
                className={`h-3.5 w-3.5 text-primary ${isExportingJson ? "animate-spin" : ""}`}
              />
              <span>{isExportingJson ? "正在导出..." : "导出 JSON"}</span>
            </Button>
          </PageToolbarActions>

          <PageToolbarFilters>
            <div className="w-44 shrink-0">
              <Select value={statusFilter} onValueChange={onStatusFilterChange}>
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部结果" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部结果</SelectItem>
                  <SelectItem value="SUCCESS" className="text-xs">执行成功 (SUCCESS)</SelectItem>
                  <SelectItem value="FAILED" className="text-xs">执行失败 (FAILED)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PageToolbarFilters>
        </PageToolbar>

        <LogTable
          logs={logs}
          onViewDetail={handleViewDetail}
          isLoading={isRefreshing}
          embedded
        />

        <TablePagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalLogs}
          pageSize={pageSize}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          disabled={isRefreshing}
        />
      </DataCard>

      {/* Detail Modal */}
      <LogDetailModal
        open={detailOpen}
        onOpenChange={setDetailOpen}
        log={selectedLog}
      />
    </div>
  );
}
