import React from "react";
import {
  RefreshCw,
  Radio,
  Check,
  SunMoon,
  Palette,
  Sparkles,
  ExternalLink,
  Download,
  AlertCircle,
  CheckCircle2,
  FileCode,
  Layers,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { useTheme } from "@/hooks/useTheme";
import { ACCENT_COLOR_PRESETS, AccentColor } from "@/theme/accentColors";
import { cn } from "@/lib/utils";
import {
  getDirectConnectionStatus,
  getProxyIpDisplay,
} from "@/components/settings/proxyIpDisplay";
import { UserAccount } from "@/services/authService";
import { tauriBridge, DesktopConfigView, StatusView } from "@/services/tauriBridge";
import {
  versionService,
  VersionCheckResult,
  UNKNOWN_VERSION,
  detectCurrentSystem,
  filterCurrentSystemAssets,
} from "@/services/versionService";

interface SystemSettingsProps {
  productName: string;
  logoUrl?: string;
  user: UserAccount;
  status: StatusView;
  desktopConfig: DesktopConfigView | null;
  configLoading: boolean;
  proxyEnabled?: boolean;
  onProxyEnabledChange?: (enabled: boolean) => void;
  sandboxEnabled?: boolean;
  onSandboxEnabledChange?: (enabled: boolean) => void;
  onSyncConfig: () => void;
}

export const SystemSettings: React.FC<SystemSettingsProps> = ({
  productName,
  logoUrl,
  user,
  status,
  desktopConfig,
  configLoading,
  proxyEnabled = true,
  onProxyEnabledChange,
  sandboxEnabled = true,
  onSandboxEnabledChange,
  onSyncConfig,
}) => {
  const { accentColor, setAccentColor } = useTheme();
  const [directIp, setDirectIp] = React.useState<string | null>(null);
  const [directIpLoading, setDirectIpLoading] = React.useState(false);

  // Version check state
  const [currentVersion, setCurrentVersion] = React.useState(UNKNOWN_VERSION);
  const [versionInfo, setVersionInfo] = React.useState<VersionCheckResult | null>(null);
  const [checkingVersion, setCheckingVersion] = React.useState(false);
  const [versionError, setVersionError] = React.useState<string | null>(null);

  const systemInfo = React.useMemo(() => detectCurrentSystem(), []);

  const displayedAssets = React.useMemo(() => {
    if (!versionInfo?.assets) return [];
    return filterCurrentSystemAssets(versionInfo.assets, systemInfo);
  }, [versionInfo?.assets, systemInfo]);

  const fetchVersion = React.useCallback(async () => {
    setCheckingVersion(true);
    setVersionError(null);
    try {
      const cur = await versionService.getCurrentVersion();
      setCurrentVersion(cur);
      const res = await versionService.checkGithubRelease();
      setVersionInfo(res);
      setCurrentVersion(res.currentVersion);
    } catch (err: any) {
      setVersionError(err?.message || "检查更新失败");
    } finally {
      setCheckingVersion(false);
    }
  }, []);

  React.useEffect(() => {
    versionService.getCurrentVersion().then(setCurrentVersion);
    fetchVersion();
  }, [fetchVersion]);

  React.useEffect(() => {
    if (!proxyEnabled) {
      setDirectIpLoading(true);
      tauriBridge
        .getDirectIp()
        .then((ip) => {
          setDirectIp(ip);
        })
        .catch(() => {
          setDirectIp("获取失败");
        })
        .finally(() => {
          setDirectIpLoading(false);
        });
    }
  }, [proxyEnabled]);

  const proxyIpDisplay = getProxyIpDisplay(
    desktopConfig,
    configLoading,
    status.phase,
  );

  const getPhaseBadge = (phase: string) => {
    switch (phase) {
      case "ready":
        return (
          <Badge variant="success" dot pulse>
            代理就绪
          </Badge>
        );
      case "browser_running":
        return (
          <Badge variant="info" dot pulse>
            浏览器运行中
          </Badge>
        );
      case "testing":
        return (
          <Badge variant="warning" dot pulse>
            正在测试连接
          </Badge>
        );
      case "proxy_error":
        return (
          <Badge variant="destructive" dot>
            代理异常
          </Badge>
        );
      default:
        return <Badge variant="secondary">未就绪</Badge>;
    }
  };

  const getConnectionStatusText = () => {
    if (!proxyEnabled) {
      return getDirectConnectionStatus(directIp, directIpLoading);
    }
    switch (status.phase) {
      case "ready":
        return "代理已连接";
      case "browser_running":
        return "浏览器运行中";
      case "testing":
        return "正在测试…";
      case "proxy_error":
        return "代理异常";
      default:
        return "未就绪";
    }
  };

  const directIpFailed = !directIpLoading && directIp === "获取失败";

  const formatFileSize = (bytes: number) => {
    if (!bytes) return "";
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">系统配置</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          查看代理环境连接状态、外观偏好设置与软件信息。
        </p>
      </div>

      {/* 1. 代理与网络状态 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm">全局代理环境</CardTitle>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium select-none">
                  代理开关
                </span>
                <Switch
                  checked={proxyEnabled}
                  onCheckedChange={onProxyEnabledChange}
                  aria-label="代理开关"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5 px-2.5"
                onClick={onSyncConfig}
                disabled={configLoading}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${configLoading ? "animate-spin" : ""}`} />
                <span>{configLoading ? "同步中…" : "重新同步配置"}</span>
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            桌面客户端网络隔离与代理调度状态
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <div
              className={cn(
                "p-2.5 rounded-lg border flex flex-col justify-between transition-colors",
                proxyEnabled
                  ? "border-primary/30 bg-primary/5"
                  : "border-border/60 bg-muted/40"
              )}
            >
              <span className="text-muted-foreground text-[11px]">网络模式</span>
              <div className="mt-1 flex items-center">
                {proxyEnabled ? (
                  <Badge variant="success" dot pulse className="text-[11px] px-2 py-0.5 shadow-xs">
                    系统全局代理
                  </Badge>
                ) : (
                  <Badge variant="secondary" dot className="text-[11px] px-2 py-0.5">
                    当前用户网络
                  </Badge>
                )}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-muted/40 border border-border/60 flex flex-col justify-between">
              <span className="text-muted-foreground text-[11px]">
                {proxyEnabled ? "代理节点 IP" : "当前本机 IP"}
              </span>
              <span
                className="font-mono font-medium text-foreground text-xs mt-1 truncate"
                title={
                  proxyEnabled
                    ? proxyIpDisplay === desktopConfig?.proxy_ip
                      ? proxyIpDisplay
                      : undefined
                    : directIp || undefined
                }
              >
                {proxyEnabled
                  ? proxyIpDisplay
                  : directIpLoading
                  ? "正在获取…"
                  : directIp || "正在检测…"}
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-muted/40 border border-border/60 flex flex-col justify-between">
              <span className="text-muted-foreground text-[11px]">连接状态</span>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full shrink-0",
                    !proxyEnabled
                      ? directIpFailed
                        ? "bg-destructive"
                        : directIpLoading || !directIp
                        ? "bg-amber-500 animate-ping"
                        : "bg-emerald-500"
                      : status.phase === "ready" || status.phase === "browser_running"
                      ? "bg-emerald-500"
                      : status.phase === "testing"
                      ? "bg-amber-500 animate-ping"
                      : "bg-destructive"
                  )}
                />
                <span className="font-medium text-foreground text-xs truncate">
                  {getConnectionStatusText()}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. 浏览器沙箱（兼容性开关） */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm">浏览器沙箱</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium select-none">
                沙箱模式
              </span>
              <Switch
                checked={sandboxEnabled}
                onCheckedChange={onSandboxEnabledChange}
                aria-label="浏览器沙箱模式开关"
              />
            </div>
          </div>
          <CardDescription className="text-xs">
            浏览器进程的安全隔离。部分 Windows 环境需关闭后才能正常打开浏览器
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div
            className={cn(
              "p-3 rounded-lg border text-xs leading-relaxed",
              sandboxEnabled
                ? "border-border/60 bg-muted/40 text-muted-foreground"
                : "border-amber-500/30 bg-amber-500/10 text-foreground"
            )}
          >
            {sandboxEnabled ? (
              <div className="flex items-start gap-2">
                <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
                <span>
                  沙箱已开启（推荐）。浏览器以完整的安全隔离运行。若在本机始终打不开平台、
                  一直白屏，可尝试关闭沙箱。
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <ShieldAlert className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" />
                <span>
                  沙箱已关闭（<span className="font-mono">--no-sandbox</span>）。仅建议在浏览器无法
                  打开时使用，这会削弱浏览器的进程隔离。
                  <span className="font-medium text-foreground">代理与网络隔离不受影响。</span>
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 3. 外观主题设置 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <SunMoon className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm">外观主题</CardTitle>
          </div>
          <CardDescription className="text-xs">
            设置客户端在明亮、暗黑或跟随系统模式间切换，并支持自定义主题色
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
            <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
              <Palette className="h-3.5 w-3.5 text-primary" />
              <span>选择主题主色：</span>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
              {(Object.keys(ACCENT_COLOR_PRESETS) as AccentColor[]).map((key) => {
                const preset = ACCENT_COLOR_PRESETS[key];
                const selected = accentColor === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={`主题色：${preset.label}`}
                    aria-pressed={selected}
                    onClick={() => setAccentColor(key)}
                    className={cn(
                      "flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-1.5 py-2.5 text-[11px] transition-all",
                      selected
                        ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20 font-semibold"
                        : "border-border/70 bg-card/60 text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                  >
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full text-white shadow-sm"
                      style={{ backgroundColor: preset.colorHex }}
                    >
                      {selected && <Check className="h-3 w-3 stroke-[3]" />}
                    </span>
                    <span className="w-full truncate text-center">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-muted/40 border border-border/60">
            <div>
              <p className="text-xs font-medium text-foreground">显示模式</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                选择“跟随系统”时，客户端将自动同步 macOS 或 Windows 操作系统的深浅色模式。
              </p>
            </div>
            <ThemeToggle variant="segmented" className="shrink-0" />
          </div>
        </CardContent>
      </Card>

      {/* 4. 软件版本与在线更新 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm">软件版本与更新检测</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5 px-2.5"
              onClick={fetchVersion}
              disabled={checkingVersion}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checkingVersion ? "animate-spin" : ""}`} />
              <span>{checkingVersion ? "检测中…" : "检查 GitHub 更新"}</span>
            </Button>
          </div>
          <CardDescription className="text-xs">
            桌面客户端当前安装版本信息及 GitHub Release 远程发布检测
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-0 text-xs">
          {/* 版本概览网格 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="p-3 rounded-lg bg-muted/40 border border-border/60 flex flex-col justify-between">
              <span className="text-muted-foreground text-[11px]">当前安装版本</span>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="font-mono font-bold text-foreground text-sm">
                  {currentVersion ? `v${currentVersion}` : "未知"}
                </span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium">
                  {currentVersion ? "本机版本" : "非桌面客户端"}
                </Badge>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-muted/40 border border-border/60 flex flex-col justify-between">
              <span className="text-muted-foreground text-[11px]">GitHub 最新发布</span>
              <div className="mt-1.5 flex items-center gap-2">
                {checkingVersion ? (
                  <span className="text-muted-foreground text-xs">正在查询 GitHub…</span>
                ) : versionInfo ? (
                  <>
                    <span className="font-mono font-bold text-foreground text-sm">
                      v{versionInfo.latestVersion}
                    </span>
                    {versionInfo.hasUpdate ? (
                      <Badge variant="success" pulse className="text-[10px] px-1.5 py-0 font-semibold gap-1">
                        <Sparkles className="w-3 h-3" />
                        <span>可升级</span>
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-emerald-600 border-emerald-500/30">
                        最新
                      </Badge>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    {versionError ? "检测失败" : "暂未检测"}
                  </span>
                )}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-muted/40 border border-border/60 flex flex-col justify-between">
              <span className="text-muted-foreground text-[11px]">版本发布时间</span>
              <div className="mt-1.5">
                <span className="font-mono text-muted-foreground text-xs">
                  {versionInfo?.publishedAt
                    ? new Date(versionInfo.publishedAt).toLocaleDateString()
                    : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* 新版本提醒 Banner */}
          {versionInfo?.hasUpdate && (
            <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
                <div>
                  <p className="font-semibold text-foreground">
                    发现新版本 v{versionInfo.latestVersion} 可用！
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    最新版本已在 GitHub Release 发布，点击可快速查看。
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => tauriBridge.openExternalUrl(versionInfo.htmlUrl)}
                className="inline-flex items-center justify-center gap-1.5 h-7 px-3 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700 active:scale-[0.98] transition-colors shrink-0 shadow-xs cursor-pointer text-xs"
              >
                <span>前往 GitHub 下载</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 已是最新版本提示 */}
          {!checkingVersion && versionInfo && !versionInfo.hasUpdate && (
            <div className="p-2.5 rounded-lg border border-border/60 bg-muted/30 flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span>
                  {currentVersion
                    ? `当前客户端已是 GitHub 发布的最新版本 (v${currentVersion})。`
                    : "读不到本机版本（未在桌面客户端中运行），未与 GitHub 最新发布比对。"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => tauriBridge.openExternalUrl(versionInfo.htmlUrl)}
                className="text-primary hover:underline inline-flex items-center gap-1 text-[11px] cursor-pointer"
              >
                <span>Release 记录</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 出错提示 */}
          {versionError && (
            <div className="p-2.5 rounded-lg border border-destructive/20 bg-destructive/10 text-destructive flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{versionError}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchVersion}
                className="h-6 text-xs px-2 text-destructive hover:bg-destructive/10"
              >
                重试
              </Button>
            </div>
          )}

          {/* 安装包下载列表 (当有当前系统 assets 时展示) */}
          {versionInfo && displayedAssets.length > 0 && (
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] font-medium">
                <Download className="w-3.5 h-3.5 text-primary" />
                <span>当前系统原生安装包（{systemInfo.label} · GitHub 下载源）：</span>
              </div>
              <div
                className={
                  displayedAssets.length === 1
                    ? "grid grid-cols-1 gap-1.5"
                    : "grid grid-cols-1 sm:grid-cols-2 gap-1.5"
                }
              >
                {displayedAssets.map((asset) => (
                  <button
                    type="button"
                    key={asset.name}
                    onClick={() => tauriBridge.openExternalUrl(asset.downloadUrl)}
                    className="flex items-center justify-between p-2.5 rounded-md border border-border/60 bg-card hover:bg-muted/60 hover:border-primary/40 active:scale-[0.99] transition-all text-xs group cursor-pointer text-left w-full"
                  >
                    <div className="flex items-center gap-2 truncate mr-2">
                      <FileCode className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
                      <span className="font-medium text-foreground truncate" title={asset.name}>
                        {asset.platform}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 text-muted-foreground text-[11px]">
                      {asset.size > 0 && <span>{formatFileSize(asset.size)}</span>}
                      <Download className="w-3 h-3 group-hover:text-primary" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
};
