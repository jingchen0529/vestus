import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw } from "lucide-react";
import { NavTab } from "./sidebar";

interface HeaderProps {
  currentTab: NavTab;
  onRefreshCurrent: () => void;
  isRefreshing?: boolean;
}

const tabTitles: Record<NavTab, { title: string; subtitle: string }> = {
  dashboard: { title: "控制总览", subtitle: "系统状态与综合统计指标" },
  users: { title: "桌面用户管理", subtitle: "管理桌面客户端受权账号、并发与到期时间" },
  desktop: { title: "全局代理配置", subtitle: "配置所有桌面用户共享的代理节点，系统最多启用一个" },
  platforms: { title: "平台统一管理", subtitle: "统一维护业务平台入口与可用状态" },
  admins: { title: "系统管理控制", subtitle: "超级管理员与普通管理员受权及安全控制" },
  settings: { title: "系统全局配置", subtitle: "自定义管理端与桌面端品牌名称、Logo 图标及主题配色风格" },
  logs: { title: "审计日志追踪", subtitle: "完整追踪桌面端与管理员操作轨迹" },
};

export function Header({
  currentTab,
  onRefreshCurrent,
  isRefreshing = false,
}: HeaderProps) {
  const { user } = useAuth();

  const currentInfo = tabTitles[currentTab] || { title: "管理后台", subtitle: "" };

  return (
    <header className="sticky top-0 z-10 flex h-16 w-full items-center justify-between border-b bg-card/80 backdrop-blur px-6 transition-colors">
      {/* Title & Breadcrumbs */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight text-foreground">
            {currentInfo.title}
          </h1>
          {user?.role === "super_admin" && (
            <Badge variant="primary" className="text-[10px] px-1.5 py-0">
              超级管理员模式
            </Badge>
          )}
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
