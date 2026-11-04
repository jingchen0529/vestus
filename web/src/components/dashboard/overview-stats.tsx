import { Card, CardContent } from "@/components/ui/card";
import type { ComponentType, ReactNode } from "react";
import { Users, Server, Globe, ShieldCheck, ScrollText } from "lucide-react";
import { UserStats } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { PlatformItem } from "@/types/platform";
import { AdminUser } from "@/types/admin";
import { cn } from "@/lib/utils";

interface OverviewStatsProps {
  userStats?: UserStats | null;
  proxies: ProxyItem[];
  platforms: PlatformItem[];
  admins: AdminUser[];
  totalLogs?: number;
}

/** 三段式占比条：正常 / 禁用 / 锁定，宽度按实际比例分配。 */
function CompositionBar({
  segments,
}: {
  segments: { value: number; className: string; label: string }[];
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) {
    return <div className="h-1.5 w-full rounded-full bg-white/10" aria-hidden />;
  }
  return (
    <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-white/10">
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.label}
            className={cn("h-full first:rounded-l-full last:rounded-r-full", s.className)}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label} ${s.value}`}
          />
        ))}
    </div>
  );
}

/** 小卡：数字 + 单行注解，去掉装饰块，只留左侧一道细色条。 */
function StatTile({
  label,
  value,
  unit,
  icon: Icon,
  meta,
}: {
  label: string;
  value: number;
  unit: string;
  icon: ComponentType<{ className?: string }>;
  meta: ReactNode;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/70 shadow-none transition-all duration-200 hover:border-border hover:shadow-soft">
      <span className="absolute inset-y-3 left-0 w-px bg-primary/40 transition-all duration-200 group-hover:inset-y-0 group-hover:w-[3px] group-hover:bg-primary" />
      <CardContent className="flex h-full flex-col justify-between gap-3 py-4 pl-5 pr-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
            {label}
          </span>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary" />
        </div>
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-[26px] font-medium leading-none tracking-[-0.03em] text-foreground">
              {value}
            </span>
            <span className="text-[11px] text-muted-foreground">{unit}</span>
          </div>
          <div className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
            {meta}
          </div>
        </div>
      </CardContent>
    </Card>
  );
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

  const total = userStats?.total ?? 0;
  const active = userStats?.active ?? 0;
  const disabled = userStats?.disabled ?? 0;
  const locked = userStats?.locked ?? 0;
  const activeRate = total > 0 ? Math.round((active / total) * 100) : 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* 主卡：桌面端用户 —— 深墨底，整页唯一的强对比区域 */}
      <Card className="relative overflow-hidden border-0 bg-[hsl(220_18%_9%)] text-white shadow-lift dark:border dark:border-white/[0.07] dark:bg-[hsl(220_16%_14%)] sm:col-span-2 lg:row-span-2">
        <div className="pointer-events-none absolute inset-0 bg-grid-dark opacity-[0.55]" />
        <div className="pointer-events-none absolute inset-0 bg-noise" />
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-[hsl(168_60%_40%)] opacity-[0.14] blur-[70px]" />
        <CardContent className="relative flex h-full flex-col justify-center gap-7 p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-white/45">
                <Users className="h-3.5 w-3.5" />
                <span>桌面端用户</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-[56px] font-medium leading-none tracking-[-0.04em] text-[hsl(168_58%_62%)]">
                  {total}
                </span>
                <span className="text-xs text-white/40">人注册授权</span>
              </div>
            </div>
            <div className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/70">
              {activeRate}% 可用
            </div>
          </div>

          <div className="space-y-3">
            <CompositionBar
              segments={[
                { value: active, className: "bg-[hsl(168_58%_52%)]", label: "正常" },
                { value: disabled, className: "bg-white/25", label: "禁用" },
                { value: locked, className: "bg-[hsl(38_88%_58%)]", label: "锁定" },
              ]}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-white/55">
              <span className="flex items-center gap-1.5">
                <i className="h-1.5 w-1.5 rounded-full bg-[hsl(168_58%_52%)]" />
                {active} 正常
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-1.5 w-1.5 rounded-full bg-white/25" />
                {disabled} 禁用
              </span>
              {locked > 0 && (
                <span className="flex items-center gap-1.5">
                  <i className="h-1.5 w-1.5 rounded-full bg-[hsl(38_88%_58%)]" />
                  {locked} 锁定
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <StatTile
        label="VPN 代理节点池"
        value={proxies.length}
        unit="个节点"
        icon={Server}
        meta={
          <>
            <span className="text-success">{activeProxies} 个启用</span>
            <span className="mx-1.5 text-border">·</span>
            可按用户单独指派
          </>
        }
      />

      <StatTile
        label="预设业务平台"
        value={platforms.length}
        unit="个入口"
        icon={Globe}
        meta={
          <>
            <span className="text-primary">{activePlatforms} 正常投放</span>
            <span className="mx-1.5 text-border">·</span>
            {platforms.length - activePlatforms} 已下架
          </>
        }
      />

      <StatTile
        label="系统管理员"
        value={admins.length}
        unit="名成员"
        icon={ShieldCheck}
        meta={
          <>
            {superAdmins} 名超级管理员
            <span className="mx-1.5 text-border">·</span>
            按角色分权
          </>
        }
      />

      <StatTile
        label="审计动态"
        value={totalLogs ?? 0}
        unit="条记录"
        icon={ScrollText}
        meta={
          <>
            管理员与桌面端操作留痕
            <span className="mx-1.5 text-border">·</span>
            实时入库
          </>
        }
      />
    </div>
  );
}
