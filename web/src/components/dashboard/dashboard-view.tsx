import { OverviewStats } from "./overview-stats";
import { QuickActions } from "./quick-actions";
import { UserStats } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { PlatformItem } from "@/types/platform";
import { AdminUser } from "@/types/admin";
import { UserLogItem } from "@/types/log";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate, cn } from "@/lib/utils";
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
              <History className="h-4 w-4 text-primary" />
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
            <div>
              {/* 列头：让数字与时间有稳定的落位，而不是每行各自浮动 */}
              <div className="hidden grid-cols-[56px_1fr_120px_132px] gap-3 border-b border-border/60 pb-2 text-[10px] font-medium tracking-[0.06em] text-muted-foreground/55 sm:grid">
                <span>状态</span>
                <span>操作者 / 内容</span>
                <span>来源 IP</span>
                <span className="text-right">时间</span>
              </div>
              <div className="divide-y divide-border/50">
                {recentLogs.slice(0, 6).map((log) => {
                  const ok = log.status === "SUCCESS";
                  return (
                    <div
                      key={log.id}
                      className="grid grid-cols-[56px_1fr_auto] items-center gap-3 py-2.5 text-xs transition-colors hover:bg-muted/25 sm:grid-cols-[56px_1fr_120px_132px]"
                    >
                      <span
                        className={cn(
                          "flex items-center gap-1.5 text-[11px] font-medium",
                          ok ? "text-success" : "text-destructive",
                        )}
                      >
                        <i
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            ok ? "bg-success" : "bg-destructive",
                          )}
                        />
                        {ok ? "成功" : "失败"}
                      </span>

                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-mono text-[11px] font-medium text-foreground">
                          {log.actorUsername || "系统"}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {log.summary || log.action}
                        </span>
                      </div>

                      <span className="hidden truncate font-mono text-[10.5px] text-muted-foreground/70 sm:block">
                        {log.ipAddress || "—"}
                      </span>

                      <span className="whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground/70">
                        {formatDate(log.createdAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
