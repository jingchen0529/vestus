import * as React from "react";
import { Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * 统一的列表页数据面板容器：将顶部操作/筛选工具栏、表格主体与底部分页收纳为一体。
 */
export const DataCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <Card
    ref={ref}
    className={cn("border-border/80 shadow-sm overflow-hidden", className)}
    {...props}
  />
));
DataCard.displayName = "DataCard";

/**
 * 统一的列表页顶部工具栏：左侧放置主按钮与批量/刷新/导出动作，右侧放置搜索与筛选器。
 */
export const PageToolbar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex flex-col md:flex-row md:items-center justify-between gap-2.5 px-4 py-3 border-b border-border/70 bg-muted/15",
      className
    )}
    {...props}
  />
));
PageToolbar.displayName = "PageToolbar";

export const PageToolbarActions = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-wrap items-center gap-2 shrink-0", className)}
    {...props}
  />
));
PageToolbarActions.displayName = "PageToolbarActions";

export const PageToolbarFilters = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex flex-1 flex-wrap items-center gap-2 md:justify-end",
      className
    )}
    {...props}
  />
));
PageToolbarFilters.displayName = "PageToolbarFilters";

export interface ToolbarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * 统一规格（h-8 / text-xs）的工具栏搜索框，支持一键清空。
 */
export function ToolbarSearch({
  value,
  onChange,
  placeholder = "搜索...",
  className,
}: ToolbarSearchProps) {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-9 pr-7 text-xs rounded-md border-border/70 bg-background/90 shadow-none hover:border-border focus-visible:bg-background"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="清空搜索"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

