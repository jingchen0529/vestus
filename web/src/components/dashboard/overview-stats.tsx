import { Card, CardContent } from "@/components/ui/card";
import { Users, Server, Globe, ShieldCheck, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { UserStats } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { PlatformItem } from "@/types/platform";
import { AdminUser } from "@/types/admin";

interface OverviewStatsProps {
  userStats?: UserStats | null;
  proxies: ProxyItem[];
  platforms: PlatformItem[];
  admins: AdminUser[];
  totalLogs?: number;
}

export function OverviewStats({
  userStats,
  proxies,
  platforms,
  admins,
  totalLogs,
}: OverviewStatsProps) {
  const activeProxies = proxies.filter((p) => p.status === "active").length;
  const activePlatforms = platforms.filter((p) => p.status === "active").length;
  const superAdmins = admins.filter((a) => a.role === "super_admin").length;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Users Card */}
      <Card className="hover:shadow-md transition-shadow relative overflow-hidden border-border/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-bl-full pointer-events-none" />
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              桌面端用户
            </span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Users className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight text-foreground">
              {userStats?.total ?? 0}
            </span>
            <span className="text-xs text-muted-foreground">人注册授权</span>
          </div>
          <div className="mt-4 flex items-center gap-3 text-xs border-t pt-3">
            <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>{userStats?.active ?? 0} 正常</span>
            </div>
            <div className="flex items-center gap-1 text-slate-500">
              <XCircle className="h-3.5 w-3.5" />
              <span>{userStats?.disabled ?? 0} 禁用</span>
            </div>
            {(userStats?.locked ?? 0) > 0 && (
              <div className="flex items-center gap-1 text-amber-500 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{userStats?.locked} 锁定</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Proxy Pool Card */}
      <Card className="hover:shadow-md transition-shadow relative overflow-hidden border-border/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-bl-full pointer-events-none" />
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              专属代理池
            </span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Server className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight text-foreground">
              {proxies.length}
            </span>
            <span className="text-xs text-muted-foreground">套配置</span>
          </div>
          <div className="mt-4 flex items-center gap-3 text-xs border-t pt-3">
            <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>{activeProxies} 在线启用</span>
            </div>
            <div className="flex items-center gap-1 text-slate-500">
              <span>{proxies.length - activeProxies} 停用</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Platform Shortcuts Card */}
      <Card className="hover:shadow-md transition-shadow relative overflow-hidden border-border/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-bl-full pointer-events-none" />
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              预设业务平台
            </span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Globe className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight text-foreground">
              {platforms.length}
            </span>
            <span className="text-xs text-muted-foreground">个平台入口</span>
          </div>
          <div className="mt-4 flex items-center gap-3 text-xs border-t pt-3">
            <div className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>{activePlatforms} 正常投放</span>
            </div>
            <div className="flex items-center gap-1 text-slate-500">
              <span>{platforms.length - activePlatforms} 已下架</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Admins Card */}
      <Card className="hover:shadow-md transition-shadow relative overflow-hidden border-border/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-primary/5 rounded-bl-full pointer-events-none" />
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              系统管理员
            </span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight text-foreground">
              {admins.length}
            </span>
            <span className="text-xs text-muted-foreground">名管理成员</span>
          </div>
          <div className="mt-4 flex items-center gap-3 text-xs border-t pt-3">
            <div className="flex items-center gap-1 text-primary font-medium">
              <span>{superAdmins} 名超级管理员</span>
            </div>
            {totalLogs !== undefined && (
              <div className="text-slate-500 ml-auto">
                <span>{totalLogs} 条日志</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
