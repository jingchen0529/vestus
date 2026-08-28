import React from "react";
import {
  RefreshCw,
  Radio,
  Check,
  SunMoon,
  Palette,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { useTheme } from "@/hooks/useTheme";
import { ACCENT_COLOR_PRESETS, AccentColor } from "@/theme/accentColors";
import { cn } from "@/lib/utils";
import { getProxyIpDisplay } from "@/components/settings/proxyIpDisplay";
import { UserAccount } from "@/services/authService";
import { tauriBridge, DesktopConfigView, StatusView } from "@/services/tauriBridge";

interface SystemSettingsProps {
  productName: string;
  logoUrl?: string;
  user: UserAccount;
  status: StatusView;
  desktopConfig: DesktopConfigView | null;
  configLoading: boolean;
  proxyEnabled?: boolean;
  onProxyEnabledChange?: (enabled: boolean) => void;
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
  onSyncConfig,
}) => {
  const { accentColor, setAccentColor } = useTheme();
  const [directIp, setDirectIp] = React.useState<string | null>(null);
  const [directIpLoading, setDirectIpLoading] = React.useState(false);

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
      return directIpLoading ? "正在检测…" : "直连正常";
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
              <CardTitle className="text-sm">专属代理环境</CardTitle>
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
                    系统专属代理
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
                      ? "bg-emerald-500"
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

      {/* 2. 外观主题设置 */}
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


    </section>
  );
};
