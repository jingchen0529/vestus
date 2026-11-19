import React from "react";
import { Activity, AlertCircle, CheckCircle2, Clock3, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NetworkDiagnosticsSnapshot } from "@/services/tauriBridge";
import { formatDiagnosticsTime, toNetworkDiagnosticsView } from "./networkDiagnosticsView";

interface NetworkDiagnosticsCardProps {
  snapshot: NetworkDiagnosticsSnapshot | null;
  loading?: boolean;
}

const badgeVariant = (tone: "success" | "warning" | "destructive" | "secondary") => tone;

export const NetworkDiagnosticsCard: React.FC<NetworkDiagnosticsCardProps> = ({ snapshot, loading = false }) => {
  const view = toNetworkDiagnosticsView(snapshot);
  return (
    <Card data-testid="network-diagnostics-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="h-4 w-4 shrink-0 text-primary" />
            <CardTitle>网络诊断</CardTitle>
          </div>
          {loading ? <Badge variant="info" dot pulse>采样中</Badge> : <Badge variant={view.latestAtMs === null ? "secondary" : "outline"}>{view.latestAtMs === null ? "等待采样" : "最近采样"}</Badge>}
        </div>
        <CardDescription>只读展示桌面端最近一次网络采样，不会发起额外测速请求</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          <span>最近采样 {formatDiagnosticsTime(view.latestAtMs)}</span>
        </div>
        <div className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-3">
          {view.routes.map((route) => (
            <div key={route.key} className="min-w-0 rounded-lg border border-border/60 bg-muted/30 p-2.5">
              <div className="truncate text-[11px] text-muted-foreground">{route.label}</div>
              <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
                {route.tone === "success" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" /> : <AlertCircle className={cn("h-3.5 w-3.5 shrink-0", route.tone === "destructive" ? "text-destructive" : "text-warning")} />}
                <Badge variant={badgeVariant(route.tone)} className="max-w-full truncate">{route.statusLabel}</Badge>
              </div>
              {route.sample?.durationMs != null && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">耗时 {route.sample.durationMs} ms</div>}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[11px]">
          <span className="flex items-center gap-1.5 text-muted-foreground"><UploadCloud className="h-3.5 w-3.5" /><Badge variant={view.uploadTone}>{view.uploadLabel}</Badge></span>
          <span className="text-muted-foreground">待上报 {view.queuedCount} · 丢弃 {view.droppedCount}</span>
        </div>
      </CardContent>
    </Card>
  );
};
