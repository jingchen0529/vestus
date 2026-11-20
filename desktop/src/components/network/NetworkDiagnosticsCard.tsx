import React, { useState } from "react";
import { Activity, ChevronDown, Clock3, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NetworkDiagnosticsSnapshot } from "@/services/tauriBridge";
import {
  formatCompactUploadSummary,
  formatDiagnosticsTimestampLabel,
  toNetworkDiagnosticsView,
} from "./networkDiagnosticsView";

type DiagnosticsTone = "success" | "warning" | "destructive" | "secondary";

const READ_ONLY_HINT = "只读展示桌面端最近一次网络采样，不会发起额外测速请求";

interface NetworkDiagnosticsCardProps {
  snapshot: NetworkDiagnosticsSnapshot | null;
  loading?: boolean;
  /** 紧凑模式：用于平台入口顶部，压缩纵向占位，上报详情按需展开。 */
  compact?: boolean;
  className?: string;
}

const dotToneClass = (tone: DiagnosticsTone): string => {
  switch (tone) {
    case "success":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "destructive":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/45";
  }
};

const textToneClass = (tone: DiagnosticsTone): string => {
  switch (tone) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "destructive":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
};

const surfaceToneClass = (tone: DiagnosticsTone): string => {
  switch (tone) {
    case "destructive":
      return "bg-destructive/[0.04]";
    case "warning":
      return "bg-warning/[0.04]";
    default:
      return "";
  }
};

const cardTileToneClass = (tone: DiagnosticsTone): string => {
  switch (tone) {
    case "destructive":
      return "border-destructive/25 bg-destructive/[0.04]";
    case "warning":
      return "border-warning/25 bg-warning/[0.04]";
    default:
      return "border-border/60 bg-muted/40";
  }
};

export const NetworkDiagnosticsCard: React.FC<NetworkDiagnosticsCardProps> = ({
  snapshot,
  loading = false,
  compact = false,
  className,
}) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const view = toNetworkDiagnosticsView(snapshot);
  const timestampLabel = formatDiagnosticsTimestampLabel(view.latestAtMs);
  const hasUploadAttention = view.uploadTone === "destructive" || view.droppedCount > 0;
  const compactRouteGridClass = view.routes.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2";
  const defaultRouteGridClass = view.routes.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";

  if (compact) {
    const uploadSummary = formatCompactUploadSummary(view);
    return (
      <div
        data-testid="network-diagnostics-card"
        data-variant="compact"
        className={cn(
          "rounded-[12px] border border-border/70 bg-card px-3.5 py-2.5 text-card-foreground transition-colors",
          className,
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex shrink-0 items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-primary" />
              <span className="text-[12px] font-semibold tracking-[-0.01em] text-foreground">
                网络诊断
              </span>
            </div>
            <span className="h-3 w-px shrink-0 bg-border/80" aria-hidden="true" />
            {loading ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-info">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
                采样中
              </span>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] tabular-nums text-muted-foreground">
                <Clock3 className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                <span className="truncate">{timestampLabel}</span>
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            title={READ_ONLY_HINT}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] transition-colors",
              hasUploadAttention
                ? "bg-destructive/10 font-medium text-destructive hover:bg-destructive/15"
                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <UploadCloud
              className={cn(
                "h-3 w-3 shrink-0",
                view.uploadTone === "success" && !hasUploadAttention && "text-success",
              )}
            />
            <span className="tabular-nums">{uploadSummary}</span>
            <ChevronDown
              className={cn(
                "h-3 w-3 shrink-0 opacity-70 transition-transform duration-150",
                detailsOpen && "rotate-180",
              )}
            />
          </button>
        </div>

        <div className={cn(
          "mt-2 grid grid-cols-1 divide-y divide-border/60 overflow-hidden rounded-[8px] border border-border/60 bg-muted/30 md:divide-x md:divide-y-0",
          compactRouteGridClass,
        )}>
          {view.routes.map((route) => {
            const durationText =
              route.sample?.durationMs != null ? `${route.sample.durationMs} ms` : null;
            const tooltip = durationText
              ? `${route.label}：${route.statusLabel}（耗时 ${durationText}）`
              : `${route.label}：${route.statusLabel}`;
            return (
              <div
                key={route.key}
                title={tooltip}
                className={cn(
                  "flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-2.5 py-1.5",
                  surfaceToneClass(route.tone),
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      dotToneClass(route.tone),
                      route.sample?.status === "testing" && "animate-pulse",
                    )}
                  />
                  <span className="shrink-0 text-[11px] font-medium text-foreground/80">
                    {route.label}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("truncate text-[11px] font-medium", textToneClass(route.tone))}>
                    {route.statusLabel}
                  </span>
                  {durationText && (
                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {durationText}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {detailsOpen && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border/60 pt-2 text-[10.5px] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={view.uploadTone} className="px-1.5 py-0 text-[10px]">
                {view.uploadLabel}
              </Badge>
              <span className="tabular-nums">
                待上报 {view.queuedCount} · 丢弃 {view.droppedCount}
              </span>
            </div>
            <span className="text-muted-foreground/80">{READ_ONLY_HINT}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <Card data-testid="network-diagnostics-card" data-variant="default" className={className}>
      <CardHeader className="pb-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="h-4 w-4 shrink-0 text-primary" />
            <CardTitle className="text-sm">网络诊断</CardTitle>
          </div>
          {loading ? (
            <Badge variant="info" dot pulse>
              采样中
            </Badge>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10.5px] tabular-nums text-muted-foreground">
              <Clock3 className="h-3 w-3 shrink-0" />
              <span>{timestampLabel}</span>
            </span>
          )}
        </div>
        <CardDescription className="text-xs">{READ_ONLY_HINT}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5 pt-0">
        <div className={cn("grid grid-cols-1 gap-2", defaultRouteGridClass)}>
          {view.routes.map((route) => {
            const durationText =
              route.sample?.durationMs != null ? `${route.sample.durationMs} ms` : null;
            return (
              <div
                key={route.key}
                className={cn(
                  "min-w-0 rounded-lg border px-2.5 py-2 transition-colors",
                  cardTileToneClass(route.tone),
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-muted-foreground">{route.label}</span>
                  {durationText && (
                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {durationText}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      dotToneClass(route.tone),
                      route.sample?.status === "testing" && "animate-pulse",
                    )}
                  />
                  <span className={cn("truncate text-[12px] font-medium", textToneClass(route.tone))}>
                    {route.statusLabel}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <UploadCloud className="h-3.5 w-3.5" />
            <Badge variant={view.uploadTone}>{view.uploadLabel}</Badge>
          </span>
          <span className="tabular-nums">
            待上报 {view.queuedCount} · 丢弃 {view.droppedCount}
          </span>
        </div>
      </CardContent>
    </Card>
  );
};
