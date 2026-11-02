import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getPageItems } from "@/lib/pagination";
import { cn } from "@/lib/utils";

export interface TablePaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  disabled?: boolean;
  pageSizeOptions?: number[];
  className?: string;
}

/**
 * 统一的表格底部分页栏，激活页码自动跟随系统主题主色（primary）。
 */
export function TablePagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  disabled = false,
  pageSizeOptions = [10, 30, 50, 100],
  className,
}: TablePaginationProps) {
  const safeTotalPages = Math.max(totalPages, 1);

  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-border/70 bg-muted/10 text-xs text-muted-foreground",
        className
      )}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          第 <strong className="text-foreground">{currentPage}</strong> 页，共{" "}
          <strong className="text-foreground">{safeTotalPages}</strong> 页 · 共{" "}
          <strong className="text-foreground">{totalItems}</strong> 条记录
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">每页</span>
          <Select
            value={String(pageSize)}
            onValueChange={(val) => onPageSizeChange?.(Number(val))}
          >
            <SelectTrigger size="sm" className="h-7 w-[78px] px-2">
              <SelectValue placeholder={`${pageSize} 条`}>{`${pageSize} 条`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((opt) => (
                <SelectItem key={opt} value={String(opt)} className="text-xs">
                  {opt} 条
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(1)}
          disabled={currentPage <= 1 || disabled}
          title="第一页"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1 || disabled}
          title="上一页"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>

        {getPageItems(currentPage, safeTotalPages).map((item, idx) => {
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
              disabled={disabled}
              className={cn(
                "min-w-[2rem] px-2",
                isCurrent ? "font-semibold" : "font-normal"
              )}
            >
              {item}
            </Button>
          );
        })}

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= safeTotalPages || disabled}
          title="下一页"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(safeTotalPages)}
          disabled={currentPage >= safeTotalPages || disabled}
          title="最后一页"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

