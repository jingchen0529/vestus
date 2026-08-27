import { useState } from "react";
import { LogTable } from "./log-table";
import { LogDetailModal } from "./log-detail-modal";
import { UserLogItem } from "@/types/log";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshCw, FileJson, FileSpreadsheet, ChevronLeft, ChevronRight } from "lucide-react";
import { exportToJsonFile, exportToCsvFile } from "@/lib/export-utils";
import { toast } from "sonner";

interface LogsViewProps {
  logs: UserLogItem[];
  totalLogs: number;
  currentPage: number;
  pageSize: number;
  onPageChange: (page: number) => void;
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
  statusFilter,
  onStatusFilterChange,
  onRefresh,
  isRefreshing,
}: LogsViewProps) {
  const [selectedLog, setSelectedLog] = useState<UserLogItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const handleViewDetail = (log: UserLogItem) => {
    setSelectedLog(log);
    setDetailOpen(true);
  };

  const handleExportJson = () => {
    if (logs.length === 0) {
      toast.warning("当前列表无数据可导出");
      return;
    }
    exportToJsonFile(logs, `vestus-audit-logs-p${currentPage}-${new Date().toISOString().slice(0, 10)}.json`);
    toast.success(`已导出 ${logs.length} 条审计日志 (JSON)`);
  };

  const handleExportCsv = () => {
    if (logs.length === 0) {
      toast.warning("当前列表无数据可导出");
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
    exportToCsvFile(headers, logs, `vestus-audit-logs-p${currentPage}-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`已导出 ${logs.length} 条审计日志 (CSV)`);
  };

  const totalPages = Math.ceil(totalLogs / pageSize) || 1;

  return (
    <div className="space-y-4 animate-in fade-in-50 duration-300">
      {/* Top Toolbar */}
      <Card className="border-border/80 shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            {/* Left Action Buttons */}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isRefreshing}
                className="h-9 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                <span>刷新</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleExportCsv}
                className="h-9 gap-1.5 text-xs font-medium"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
                <span>导出 CSV</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleExportJson}
                className="h-9 gap-1.5 text-xs font-medium"
              >
                <FileJson className="h-3.5 w-3.5 text-blue-600" />
                <span>导出 JSON</span>
              </Button>
            </div>

            {/* Right Filter */}
            <div className="flex flex-1 items-center justify-end">
              <div className="w-36 shrink-0">
                <Select
                  value={statusFilter}
                  onValueChange={onStatusFilterChange}
                >
                  <SelectTrigger className="h-9 text-xs">
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
      <div className="flex items-center justify-between px-2 text-xs text-muted-foreground">
        <div>
          共 <strong className="text-foreground">{totalLogs}</strong> 条审计记录 · 当前第 {currentPage} / {totalPages} 页
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1 || isRefreshing}
            className="h-8 gap-1 text-xs px-2.5"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span>上一页</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || isRefreshing}
            className="h-8 gap-1 text-xs px-2.5"
          >
            <span>下一页</span>
            <ChevronRight className="h-3.5 w-3.5" />
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
