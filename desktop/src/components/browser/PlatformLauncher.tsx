import React, { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Globe,
  RefreshCw,
  ShieldAlert,
  ShieldOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DesktopConfigView,
  DesktopManagedAccount,
  DesktopPlatform,
  StatusView,
} from "@/services/tauriBridge";
import { cn } from "@/lib/utils";

// 自动登录恢复中的账号不再要求用户联系管理员：系统会自行恢复并重开浏览器。
const isRecovering = (account?: DesktopManagedAccount | null): boolean =>
  Boolean(
    account?.auto_relogin &&
      ["pending", "running", "retry_wait"].includes(account?.recovery_status || ""),
  );

interface PlatformLauncherProps {
  status: StatusView;
  desktopConfig: DesktopConfigView | null;
  configLoading: boolean;
  configError: string | null;
  proxyEnabled?: boolean;
  onRetryConfig: () => void;
  onOpenBrowser: (platformId: number, managedAccountId?: number) => Promise<void> | void;
}

/** 统一提示条：三种语气共用一套骨架，避免每条自己配色。 */
function Notice({
  tone,
  icon: Icon,
  children,
  action,
}: {
  tone: "warning" | "danger" | "info";
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const styles = {
    warning: "border-warning/25 bg-warning/[0.06] text-warning",
    danger: "border-destructive/25 bg-destructive/[0.06] text-destructive",
    info: "border-border/70 bg-muted/40 text-muted-foreground",
  }[tone];

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5",
        styles,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 text-[11.5px] leading-relaxed">{children}</div>
      </div>
      {action}
    </div>
  );
}

/** 平台图标位：没有图标时用平台名首字做单字标，不用彩色渐变方块。 */
function PlatformMark({
  name,
  iconUrl,
  muted,
}: {
  name: string;
  iconUrl?: string | null;
  muted?: boolean;
}) {
  if (iconUrl) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-border/70 bg-background p-1">
        <img src={iconUrl} alt={name} className="h-full w-full object-contain" />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] text-[14px] font-semibold",
        muted
          ? "bg-muted text-muted-foreground/60"
          : "bg-primary/[0.08] text-primary",
      )}
    >
      {name.slice(0, 1)}
    </div>
  );
}

export const PlatformLauncher: React.FC<PlatformLauncherProps> = ({
  status,
  desktopConfig,
  configLoading,
  configError,
  proxyEnabled = true,
  onRetryConfig,
  onOpenBrowser,
}) => {
  const [launchingPlatformKey, setLaunchingPlatformKey] = useState<string | null>(null);
  const platforms = desktopConfig?.platforms || [];
  const directHosts = desktopConfig?.direct_hosts || [];

  // 账号不可用时的用户可读原因；unknown 状态兜底展示原始值。
  const accountStatusLabels: Record<string, string> = {
    expired: "登录状态已失效，请联系管理员或渠道客服",
    revoked: "绑定已解除",
    invalid: "账号不可用",
  };

  // 统计失效账号数量（自动恢复中的账号不算，它们不需要人工处理）
  const expiredCount = platforms.reduce(
    (sum, platform) =>
      sum +
      (platform.managed_accounts || []).filter(
        (account) => account.status === "expired" && !isRecovering(account),
      ).length,
    0,
  );

  const canLaunch =
    platforms.length > 0 &&
    (!proxyEnabled ||
      (Boolean(desktopConfig?.proxy_assigned) &&
        (status.phase === "ready" || status.phase === "browser_running")));

  const ready = status.phase === "ready" || status.phase === "browser_running";

  const handleOpenPlatform = async (platform: DesktopPlatform, managedAccountId?: number) => {
    const key = managedAccountId ? `${platform.id}:${managedAccountId}` : String(platform.id);
    setLaunchingPlatformKey(key);
    try {
      await onOpenBrowser(platform.id, managedAccountId);
    } finally {
      setLaunchingPlatformKey(null);
    }
  };

  const entries = platforms.flatMap((platform) => {
    const accounts = platform.managed_accounts?.length ? platform.managed_accounts : [null];
    return accounts.map((account) => ({ platform, account }));
  });

  return (
    <section className="mx-auto w-full max-w-3xl space-y-3.5">
      {/* 页头 */}
      <header className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-foreground">
            平台入口
          </h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
            点击在独立浏览器窗口中打开，登录状态保存在这台电脑上
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              ready ? "bg-success" : "bg-warning",
            )}
          />
          <span className="text-[10.5px] font-medium text-muted-foreground">
            {proxyEnabled ? "代理" : "直连"} · {ready ? "已就绪" : "准备中"}
          </span>
        </div>
      </header>

      {/* 提示区 */}
      {(configLoading || configError) && (
        <Notice
          tone={configError ? "warning" : "info"}
          icon={configError ? AlertTriangle : RefreshCw}
          action={
            !configLoading ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-[11px]"
                onClick={onRetryConfig}
              >
                重新加载
              </Button>
            ) : undefined
          }
        >
          {configLoading ? (
            <span className="flex items-center gap-1.5">
              <RefreshCw className="h-3 w-3 animate-spin" />
              正在加载全局平台配置…
            </span>
          ) : (
            configError
          )}
        </Notice>
      )}

      {!configLoading && !configError && !canLaunch && (
        <Notice tone="warning" icon={AlertTriangle}>
          {status.message || "浏览器环境尚未就绪，请稍后重试。"}
        </Notice>
      )}

      {expiredCount > 0 && (
        <Notice
          tone="danger"
          icon={ShieldAlert}
          action={
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
              onClick={onRetryConfig}
              title="刷新平台登录状态"
            >
              <RefreshCw className="h-3 w-3" />
              刷新
            </Button>
          }
        >
          <span className="font-medium">
            {expiredCount} 个账号登录状态已失效
          </span>
          <span className="ml-1 opacity-80">
            请联系管理员或渠道客服，处理后点「刷新」恢复
          </span>
        </Notice>
      )}

      {/* 平台卡片 */}
      {entries.length > 0 && (
        <div className="grid grid-cols-1 gap-2.5 min-[660px]:grid-cols-2">
          {entries.map(({ platform, account }) => {
            const entryKey = account ? `${platform.id}:${account.id}` : String(platform.id);
            const launching = launchingPlatformKey === entryKey;
            const recovering = isRecovering(account);
            const isExpired = Boolean(account && account.status === "expired") && !recovering;
            const unavailable = Boolean(account && account.status !== "active");
            const blocked = !canLaunch || launching || unavailable;

            return (
              <button
                type="button"
                key={entryKey}
                onClick={() => handleOpenPlatform(platform, account?.id)}
                disabled={blocked}
                className={cn(
                  "group relative flex flex-col justify-between gap-3 overflow-hidden rounded-[12px] border bg-card p-3.5 text-left transition-all duration-200",
                  isExpired
                    ? "border-destructive/30 hover:border-destructive/50"
                    : unavailable
                      ? "border-border/60 opacity-60"
                      : "border-border/70 hover:border-primary/40 hover:shadow-soft",
                  blocked ? "cursor-not-allowed" : "active:scale-[0.995]",
                )}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <PlatformMark
                    name={platform.name}
                    iconUrl={platform.icon_url}
                    muted={unavailable && !isExpired}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "truncate text-[13px] font-medium leading-tight",
                        isExpired ? "text-destructive" : "text-foreground",
                      )}
                    >
                      {platform.name}
                    </div>
                    <div className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">
                      {account ? account.name : "直接打开"}
                    </div>
                  </div>

                  {!blocked && (
                    <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 -translate-x-1 text-muted-foreground/50 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:text-primary group-hover:opacity-100" />
                  )}
                </div>

                <div className="flex items-center gap-1.5 text-[10.5px]">
                  {launching ? (
                    <span className="flex items-center gap-1.5 text-primary">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      正在打开…
                    </span>
                  ) : recovering ? (
                    <span className="flex items-center gap-1.5 text-primary">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      自动恢复登录中
                    </span>
                  ) : isExpired ? (
                    <span className="flex items-center gap-1.5 text-destructive">
                      <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                      登录失效
                    </span>
                  ) : unavailable ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                      {accountStatusLabels[account!.status] ?? account!.status}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      可用
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 空态 */}
      {!configLoading && !configError && platforms.length === 0 && (
        <div className="rounded-[12px] border border-dashed border-border/80 px-6 py-9 text-center">
          <Globe className="mx-auto h-6 w-6 text-muted-foreground/40" />
          <p className="mt-2.5 text-[12px] font-medium text-foreground">
            系统当前没有已启用的平台入口
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            请联系管理员启用平台后重新加载
          </p>
        </div>
      )}

      {/* 直连域名 */}
      {directHosts.length > 0 && (
        <div className="rounded-[10px] border border-border/70 bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <ShieldOff className="h-3 w-3 shrink-0" />
            <span>以下域名按管理员配置直连，不经过代理，使用本机真实出口 IP</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {directHosts.map((host) => (
              <span
                key={host}
                className="rounded-[5px] border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground/75"
              >
                {host}
              </span>
            ))}
          </div>
        </div>
      )}

      {status.browser_open && (
        <p className="pt-0.5 text-center text-[10.5px] leading-relaxed text-muted-foreground/70">
          浏览器已在运行；再次点击同一平台会切回它的标签页，别的平台照常独立打开
        </p>
      )}
    </section>
  );
};
