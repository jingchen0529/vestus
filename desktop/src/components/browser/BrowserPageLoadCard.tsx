import React from "react";
import { Activity, Clock3 } from "lucide-react";

import type { BrowserPageLoadEvent } from "@/services/tauriBridge";
import { cn } from "@/lib/utils";

interface BrowserPageLoadCardProps {
  event: BrowserPageLoadEvent | null;
}

const PHASE_LABELS: Record<string, string> = {
  navigation_started: "开始导航",
  response_received: "收到响应",
  dom_content_loaded: "DOMContentLoaded",
  load: "Load 完成",
  network_idle: "网络空闲",
  request_finished: "主文档完成",
  request_failed: "主文档请求失败",
};

const formatTime = (timestampMs: number): string => {
  if (!timestampMs) return "等待首次事件";
  return `最近事件 ${new Date(timestampMs).toLocaleTimeString("zh-CN", { hour12: false })}`;
};

export const BrowserPageLoadCard: React.FC<BrowserPageLoadCardProps> = ({ event }) => {
  const failed = event?.phase === "request_failed";
  const phase = event ? PHASE_LABELS[event.phase] ?? event.phase : "暂无事件";
  const status = event?.status != null ? `HTTP ${event.status}` : null;
  const elapsed = event?.elapsedMs != null ? `${event.elapsedMs} ms` : null;

  return (
    <div
      data-testid="browser-page-load-card"
      className={cn(
        "rounded-[12px] border border-border/70 bg-card px-3.5 py-2.5 text-card-foreground",
        failed && "border-destructive/25 bg-destructive/[0.04]",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className={cn("h-3.5 w-3.5", failed ? "text-destructive" : "text-primary")} />
          <span className="text-[12px] font-semibold tracking-[-0.01em] text-foreground">
            浏览器加载监听
          </span>
          <span className={cn("text-[11px] font-medium", failed ? "text-destructive" : "text-muted-foreground")}>
            {phase}
          </span>
        </div>
        <span className="inline-flex items-center gap-1 text-[10.5px] tabular-nums text-muted-foreground">
          <Clock3 className="h-3 w-3" />
          {formatTime(event?.timestampMs ?? 0)}
        </span>
      </div>

      {event ? (
        <div className="mt-2 space-y-1 text-[10.5px] text-muted-foreground">
          <div className="truncate font-mono" title={event.url}>
            {event.url}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {elapsed && <span>耗时 {elapsed}</span>}
            {status && <span>{status}</span>}
            {event.errorText && <span className="text-destructive">{event.errorText}</span>}
          </div>
        </div>
      ) : (
        <div className="mt-1 text-[10.5px] text-muted-foreground">打开平台后记录主文档导航与加载状态</div>
      )}
    </div>
  );
};
