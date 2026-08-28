import React, { useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Globe,
  ShieldOff,
  Store,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DesktopConfigView,
  DesktopPlatform,
  StatusView,
} from "@/services/tauriBridge";

interface PlatformLauncherProps {
  status: StatusView;
  desktopConfig: DesktopConfigView | null;
  configLoading: boolean;
  configError: string | null;
  proxyEnabled?: boolean;
  onRetryConfig: () => void;
  onOpenBrowser: (platformId: number) => Promise<void> | void;
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
  const [launchingPlatformId, setLaunchingPlatformId] = useState<number | null>(null);
  const platforms = desktopConfig?.platforms || [];
  const directHosts = desktopConfig?.direct_hosts || [];
  const platformIcons = [Store, Video, Globe];
  const platformColors = [
    "from-blue-600 to-indigo-600",
    "from-cyan-600 to-blue-600",
    "from-emerald-600 to-teal-600",
  ];
  const canLaunch =
    platforms.length > 0 &&
    (!proxyEnabled ||
      (Boolean(desktopConfig?.proxy_assigned) &&
        (status.phase === "ready" || status.phase === "browser_running")));

  const handleOpenPlatform = async (platform: DesktopPlatform) => {
    setLaunchingPlatformId(platform.id);
    try {
      await onOpenBrowser(platform.id);
    } finally {
      setLaunchingPlatformId(null);
    }
  };

  return (
    <section className="mx-auto w-full max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">选择平台</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            点击管理员分配的平台，在独立浏览器窗口中打开。
          </p>
        </div>
        {!proxyEnabled && (
          <span className="rounded-full bg-secondary/80 px-2.5 py-0.5 text-[11px] font-medium text-secondary-foreground border border-border">
            本机直连模式
          </span>
        )}
      </div>

      {(configLoading || configError) && (
        <div
          className={`mb-4 flex items-center justify-between gap-3 rounded-lg border p-3 ${
            configError
              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          }`}
        >
          <div className="flex items-center gap-2 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{configLoading ? "正在加载管理员分配的平台…" : configError}</span>
          </div>
          {!configLoading && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-xs px-2.5"
              onClick={onRetryConfig}
            >
              重新加载
            </Button>
          )}
        </div>
      )}

      {!configLoading && !configError && !canLaunch && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {status.message || "浏览器环境尚未就绪，请稍后重试。"}
        </div>
      )}

      {directHosts.length > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-card/60 p-3 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <ShieldOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>以下域名按管理员配置直连，不经过代理，使用本机真实出口 IP</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {directHosts.map((host) => (
              <span
                key={host}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground border border-border/50"
              >
                {host}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 单行紧凑平台列表 */}
      <div className="flex flex-col gap-2">
        {platforms.map((platform, index) => {
          const Icon = platformIcons[index % platformIcons.length];
          const color = platformColors[index % platformColors.length];
          const launching = launchingPlatformId === platform.id;

          return (
            <button
              type="button"
              key={platform.id}
              onClick={() => handleOpenPlatform(platform)}
              disabled={!canLaunch || launching}
              className="group flex items-center justify-between gap-3.5 rounded-xl border border-border/80 bg-card px-4 py-3 text-left shadow-sm hover:shadow-md transition-all hover:border-primary/50 hover:bg-accent/40 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                {platform.icon_url ? (
                  <div className="w-8 h-8 rounded-lg bg-white dark:bg-slate-900 border border-border/80 p-1 flex items-center justify-center shadow-xs shrink-0 overflow-hidden">
                    <img
                      src={platform.icon_url}
                      alt={platform.name}
                      className="w-full h-full object-contain"
                    />
                  </div>
                ) : (
                  <div className={`w-8 h-8 rounded-lg bg-gradient-to-tr ${color} flex items-center justify-center text-white shadow-sm shrink-0`}>
                    <Icon className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                    {platform.name}
                  </h3>
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground group-hover:text-primary transition-colors shrink-0">
                {launching ? (
                  <span className="text-xs text-primary animate-pulse">正在打开…</span>
                ) : (
                  <>
                    <span className="text-[11px] hidden sm:inline">打开平台</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </>
                )}
              </div>
            </button>
          );
        })}

        {!configLoading && !configError && platforms.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
            <Globe className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 text-xs text-foreground font-medium">管理员尚未分配平台入口</p>
            <p className="mt-1 text-[11px] text-muted-foreground">请联系管理员完成配置后重新加载。</p>
          </div>
        )}
      </div>

      {status.browser_open && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          浏览器窗口已打开；可继续打开任意入口，也可重复打开同一平台。
        </p>
      )}
    </section>
  );
};
