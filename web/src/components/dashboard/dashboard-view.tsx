import { OverviewStats } from "./overview-stats";
import { QuickActions } from "./quick-actions";
import { UserStats } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { PlatformItem } from "@/types/platform";
import { AdminUser } from "@/types/admin";
import { UserLogItem } from "@/types/log";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { History, ArrowRight } from "lucide-react";
import { NavTab } from "@/components/layout/sidebar";

interface DashboardViewProps {
  userStats?: UserStats | null;
  proxies: ProxyItem[];
  platforms: PlatformItem[];
  admins: AdminUser[];
  recentLogs: UserLogItem[];
  onNavigate: (tab: NavTab) => void;
  onOpenCreateUser: () => void;
  onOpenCreateProxy: () => void;
  onOpenCreatePlatform: () => void;
  onOpenCreateAdmin?: () => void;
}

export function DashboardView({
  userStats,
  proxies,
  platforms,
  admins,
  recentLogs,
  onNavigate,
  onOpenCreateUser,
  onOpenCreateProxy,
  onOpenCreatePlatform,
  onOpenCreateAdmin,
}: DashboardViewProps) {
  return (
    <div className="space-y-6 animate-in fade-in-50 duration-300">
      {/* 4 Metric Cards */}
      <OverviewStats
        userStats={userStats}
        proxies={proxies}
        platforms={platforms}
        admins={admins}
        totalLogs={recentLogs.length}
      />

      {/* Quick Action Shortcuts */}
      <QuickActions
        onNavigate={onNavigate}
        onOpenCreateUser={onOpenCreateUser}
        onOpenCreateProxy={onOpenCreateProxy}
        onOpenCreatePlatform={onOpenCreatePlatform}
        onOpenCreateAdmin={onOpenCreateAdmin}
      />

      {/* Full-width Recent Audit Activities */}
      <Card className="border-border/80 w-full shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4 text-blue-500" />
              <span>最新审计与操作动态</span>
            </CardTitle>
            <CardDescription className="text-xs">
              实时记录管理员与桌面端的登录与配置变更
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate("logs")}
            className="h-8 gap-1 text-xs text-primary hover:text-primary hover:bg-primary/10"
          >
            <span>全部日志</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </CardHeader>
        <CardContent className="pt-1">
          {recentLogs.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              暂无审计日志记录
            </div>
          ) : (
            <div className="space-y-2">
              {recentLogs.slice(0, 6).map((log) => (
                <div
                  key={log.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/40 transition-colors text-xs"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1 mr-4">
                    <Badge
                      variant={log.status === "SUCCESS" ? "success" : "destructive"}
                      className="text-[10px] px-1.5 py-0 shrink-0 whitespace-nowrap"
                    >
                      {log.status === "SUCCESS" ? "成功" : "失败"}
                    </Badge>
                    <div className="truncate flex items-center gap-2">
                      <span className="font-semibold text-foreground shrink-0 font-mono">
                        {log.actorUsername || "系统"}
                      </span>
                      <span className="text-muted-foreground truncate">
                        {log.summary || log.action}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-[11px] text-muted-foreground shrink-0">
                    {log.ipAddress && (
                      <span className="hidden sm:inline font-mono text-[10px] bg-muted/60 px-1.5 py-0.5 rounded border border-border/40">
                        {log.ipAddress}
                      </span>
                    )}
                    <span>{formatDate(log.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
