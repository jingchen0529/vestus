import React from "react";
import {
  ShieldCheck,
  RefreshCw,
  Globe,
  Radio,
  Check,
  CheckCircle2,
  User,
  Building2,
  ShieldOff,
  SunMoon,
  Palette,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { useTheme } from "@/hooks/useTheme";
import { ACCENT_COLOR_PRESETS, AccentColor } from "@/theme/accentColors";
import { cn } from "@/lib/utils";
import { getProxyIpDisplay } from "@/components/settings/proxyIpDisplay";
import { UserAccount } from "@/services/authService";
import { DesktopConfigView, StatusView } from "@/services/tauriBridge";

interface SystemSettingsProps {
  productName: string;
  logoUrl?: string;
  user: UserAccount;
  status: StatusView;
  desktopConfig: DesktopConfigView | null;
  configLoading: boolean;
  onSyncConfig: () => void;
}

export const SystemSettings: React.FC<SystemSettingsProps> = ({
  productName,
  logoUrl,
  user,
  status,
  desktopConfig,
  configLoading,
  onSyncConfig,
}) => {
  const { accentColor, setAccentColor } = useTheme();
  const directHosts = desktopConfig?.direct_hosts || [];
  const platformsCount = desktopConfig?.platforms?.length || 0;
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

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">系统配置</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          查看代理环境连接状态、直连域名列表与外观偏好设置。
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 代理与网络状态 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="w-4 h-4 text-primary" />
                <CardTitle className="text-sm">专属代理环境</CardTitle>
              </div>
              {getPhaseBadge(status.phase)}
            </div>
            <CardDescription className="text-xs">
              桌面客户端网络隔离与代理调度状态
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="rounded-lg bg-muted/40 p-2.5 border border-border/60 text-xs space-y-1">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>代理分配</span>
                <span className="font-medium text-foreground">
                  {desktopConfig?.proxy_assigned ? "已分配专属代理" : "未分配代理"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-muted-foreground">
                <span className="shrink-0">代理出口 IP</span>
                <span
                  className="max-w-[180px] truncate font-mono font-medium text-foreground"
                  title={proxyIpDisplay === desktopConfig?.proxy_ip ? proxyIpDisplay : undefined}
                >
                  {proxyIpDisplay}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>可用平台数</span>
                <span className="font-medium text-foreground">{platformsCount} 个</span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>环境信息</span>
                <span className="font-medium text-foreground truncate max-w-[160px]">
                  {status.message || "正常"}
                </span>
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs gap-1.5"
              onClick={onSyncConfig}
              disabled={configLoading}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${configLoading ? "animate-spin" : ""}`} />
              <span>{configLoading ? "正在同步配置…" : "重新同步配置"}</span>
            </Button>
          </CardContent>
        </Card>

        {/* 外观模式设置 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <SunMoon className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm">外观主题</CardTitle>
            </div>
            <CardDescription className="text-xs">
              设置客户端在明亮、暗黑或跟随系统模式间切换
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="rounded-lg border border-border/60 bg-muted/40 p-2.5">
              <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Palette className="h-3.5 w-3.5 text-primary" />
                <span>选择主题主色：</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
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
                        "flex min-w-0 flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] transition-all",
                        selected
                          ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20"
                          : "border-border/70 bg-card/60 text-muted-foreground hover:border-primary/50 hover:text-foreground",
                      )}
                    >
                      <span
                        className="flex h-5 w-5 items-center justify-center rounded-full text-white shadow-sm"
                        style={{ backgroundColor: preset.colorHex }}
                      >
                        {selected && <Check className="h-3 w-3 stroke-[3]" />}
                      </span>
                      <span className="w-full truncate">{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-muted/40 border border-border/60">
              <p className="text-xs text-muted-foreground mb-2">选择显示模式：</p>
              <ThemeToggle variant="segmented" className="w-full justify-between" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              选择“跟随系统”时，客户端将自动同步 macOS 或 Windows 操作系统的深浅色模式。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 直连域名白名单 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldOff className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm">直连域名规则</CardTitle>
            </div>
            <Badge variant="outline" className="text-[10px]">
              {directHosts.length} 个直连域名
            </Badge>
          </div>
          <CardDescription className="text-xs">
            以下域名按管理员下发的策略直连，不经过专属代理，使用本机真实出口 IP
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {directHosts.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 p-2.5 rounded-lg bg-muted/40 border border-border/60">
              {directHosts.map((host) => (
                <span
                  key={host}
                  className="rounded-md bg-card px-2 py-0.5 font-mono text-[11px] text-foreground border border-border/60 shadow-xs"
                >
                  {host}
                </span>
              ))}
            </div>
          ) : (
            <div className="p-3 text-center rounded-lg bg-muted/30 border border-dashed border-border text-xs text-muted-foreground">
              暂无直连域名规则，所有流量均经专属代理转发。
            </div>
          )}
        </CardContent>
      </Card>

      {/* 用户与软件环境信息 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm">账号与软件信息</CardTitle>
          </div>
          <CardDescription className="text-xs">
            当前登录的桌面端用户信息及客户端版本
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 border border-border/60">
              <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">账号名称：</span>
              <span className="font-medium text-foreground truncate">
                {user.name} ({user.username})
              </span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 border border-border/60">
              <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">所属企业：</span>
              <span className="font-medium text-foreground truncate">
                {user.company || "未分配企业"}
              </span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 border border-border/60">
              <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">软件版本：</span>
              <span className="font-medium text-foreground">
                {productName} 桌面客户端 v0.1.0
              </span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 border border-border/60">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span className="text-muted-foreground">运行模式：</span>
              <span className="font-medium text-foreground">Tauri 原生桌面端</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
};
