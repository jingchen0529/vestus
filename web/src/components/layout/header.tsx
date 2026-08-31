import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { NavTab } from "./sidebar";

interface HeaderProps {
  currentTab: NavTab;
  onRefreshCurrent: () => void;
  isRefreshing?: boolean;
}

const tabTitles: Record<NavTab, { title: string; subtitle: string }> = {
  dashboard: { title: "控制总览", subtitle: "系统状态与综合统计指标" },
  admins: { title: "系统管理", subtitle: "超级管理员与普通管理员授权及安全控制" },
  users: { title: "桌面用户", subtitle: "管理桌面客户端授权账号、并发与到期时间" },
  desktop: { title: "代理管理", subtitle: "配置所有桌面用户共享的代理节点，系统最多启用一个" },
  platforms: { title: "平台管理", subtitle: "统一维护业务平台入口与可用状态" },
  activity: { title: "浏览器活动", subtitle: "桌面端内置浏览器的会话、访问地址与交互统计" },
  logs: { title: "审计日志", subtitle: "完整追踪桌面端与管理员操作轨迹" },
  settings: { title: "系统配置", subtitle: "自定义管理端与桌面端品牌名称、Logo 图标及主题配色风格" },
};

export function Header({
  currentTab,
  onRefreshCurrent,
  isRefreshing = false,
}: HeaderProps) {
  const currentInfo = tabTitles[currentTab] || { title: "管理后台", subtitle: "" };

  return (
    <header className="sticky top-0 z-10 flex h-16 w-full items-center justify-between border-b bg-card/80 backdrop-blur px-6 transition-colors">
      {/* Title & Breadcrumbs */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight text-foreground">
            {currentInfo.title}
          </h1>
        </div>
        <p className="text-xs text-muted-foreground hidden sm:block">
          {currentInfo.subtitle}
        </p>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2.5">
        {/* Refresh Button */}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefreshCurrent}
          disabled={isRefreshing}
          className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          <span className="hidden md:inline">刷新数据</span>
        </Button>
      </div>
    </header>
  );
}
