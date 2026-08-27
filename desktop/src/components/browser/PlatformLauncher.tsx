import React, { useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Globe,
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
  onRetryConfig: () => void;
  onOpenBrowser: (platformId: number) => Promise<void> | void;
}

export const PlatformLauncher: React.FC<PlatformLauncherProps> = ({
  status,
  desktopConfig,
  configLoading,
  configError,
  onRetryConfig,
  onOpenBrowser,
}) => {
  const [launchingPlatformId, setLaunchingPlatformId] = useState<number | null>(null);
  const platforms = desktopConfig?.platforms || [];
  const platformIcons = [Store, Video, Globe];
  const platformColors = [
    "from-blue-600 to-indigo-600",
    "from-cyan-600 to-blue-600",
    "from-emerald-600 to-teal-600",
  ];
  const canLaunch =
    Boolean(desktopConfig?.proxy_assigned) &&
    platforms.length > 0 &&
    (status.phase === "ready" || status.phase === "browser_running");

  const handleOpenPlatform = async (platform: DesktopPlatform) => {
    setLaunchingPlatformId(platform.id);
    try {
      await onOpenBrowser(platform.id);
    } finally {
      setLaunchingPlatformId(null);
    }
  };

  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">选择平台</h2>
          <p className="mt-1 text-sm text-slate-400">
            点击管理员分配的平台，在独立浏览器窗口中打开。
          </p>
        </div>
      </div>

      {(configLoading || configError) && (
        <div
          className={`mb-5 flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
            configError
              ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
              : "border-blue-500/30 bg-blue-500/10 text-blue-200"
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
              className="h-8 shrink-0 text-xs"
              onClick={onRetryConfig}
            >
              重新加载
            </Button>
          )}
        </div>
      )}

      {!configLoading && !configError && !canLaunch && (
        <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
          {status.message || "浏览器环境尚未就绪，请稍后重试。"}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              className="group flex min-h-36 flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/75 p-5 text-left shadow-lg transition hover:-translate-y-0.5 hover:border-blue-500/50 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
            >
              <div className="flex w-full items-start justify-between gap-3">
                <div className={`rounded-xl bg-gradient-to-tr ${color} p-2.5 text-white shadow-md`}>
                  <Icon className="h-5 w-5" />
                </div>
                <ExternalLink className="h-4 w-4 text-slate-500 transition group-hover:text-blue-400" />
              </div>
              <div className="mt-5 min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-100">
                  {launching ? "正在打开…" : platform.name}
                </h3>
              </div>
            </button>
          );
        })}

        {!configLoading && !configError && platforms.length === 0 && (
          <div className="col-span-full rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center">
            <Globe className="mx-auto h-8 w-8 text-slate-600" />
            <p className="mt-3 text-sm text-slate-300">管理员尚未分配平台入口</p>
            <p className="mt-1 text-xs text-slate-500">请联系管理员完成配置后重新加载。</p>
          </div>
        )}
      </div>

      {status.browser_open && (
        <p className="mt-6 text-center text-xs text-slate-500">
          浏览器窗口已打开；可继续打开任意入口，也可重复打开同一平台。
        </p>
      )}
    </section>
  );
};
