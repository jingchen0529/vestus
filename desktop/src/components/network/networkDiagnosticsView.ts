import type { NetworkDiagnosticsSnapshot, NetworkSample } from "@/services/tauriBridge";

export type DiagnosticsRoute = "management" | "vpn" | "browser";

export interface NetworkDiagnosticsViewModel {
  latestAtMs: number | null;
  routes: Array<{
    key: DiagnosticsRoute;
    label: string;
    sample: NetworkSample | null;
    statusLabel: string;
    tone: "success" | "warning" | "destructive" | "secondary";
  }>;
  uploadLabel: string;
  uploadTone: "success" | "warning" | "destructive" | "secondary";
  queuedCount: number;
  droppedCount: number;
}

const ROUTES: Array<[DiagnosticsRoute, string]> = [
  ["management", "管理端"],
  ["vpn", "VPN 代理"],
  ["browser", "浏览器 CDP"],
];

const STATUS_LABELS: Record<string, string> = {
  success: "正常",
  ok: "正常",
  testing: "采样中",
  timeout: "连接超时",
  connect: "连接失败",
  connect_timeout: "连接超时",
  proxy_auth: "代理认证失败",
  proxy_unavailable: "代理失败",
  proxy_error: "代理失败",
  proxy_disabled: "代理未启用",
  http_status: "服务返回异常",
  dns: "DNS 解析失败",
  tls: "TLS 连接失败",
  unknown: "网络诊断失败",
  error: "网络诊断失败",
  cdp_unavailable: "CDP 不可用",
  browser_closed: "浏览器已关闭",
  unavailable: "暂不可用",
};

function effectiveStatus(sample: NetworkSample | null): string | undefined {
  if (!sample) return undefined;
  return sample.status === "error" && sample.errorCode ? sample.errorCode : sample.status;
}

function labelForStatus(status: string | undefined): string {
  if (!status) return "暂无采样";
  return STATUS_LABELS[status] ?? "网络诊断失败";
}

function toneForStatus(status: string | undefined): "success" | "warning" | "destructive" | "secondary" {
  if (!status) return "secondary";
  if (["success", "ok"].includes(status)) return "success";
  if (["testing", "proxy_disabled", "cdp_unavailable", "browser_closed", "unavailable"].includes(status)) return "warning";
  return "destructive";
}

/** Converts the IPC snapshot into a stable, route-complete presentation model. */
export function toNetworkDiagnosticsView(snapshot: NetworkDiagnosticsSnapshot | null): NetworkDiagnosticsViewModel {
  const samples = snapshot?.samples ?? [];
  const byRoute = new Map<string, NetworkSample>();
  for (const sample of samples) {
    const previous = byRoute.get(sample.route);
    if (!previous || sample.startedAtMs >= previous.startedAtMs) byRoute.set(sample.route, sample);
  }
  const latestAtMs = samples.reduce<number | null>((latest, sample) => {
    return latest === null || sample.startedAtMs > latest ? sample.startedAtMs : latest;
  }, null);
  const extended = snapshot as (NetworkDiagnosticsSnapshot & {
    uploadStatus?: string;
    queuedCount?: number;
    queueCount?: number;
    droppedCount?: number;
    droppedSamples?: number;
  }) | null;
  const uploadStatus = extended?.uploadStatus;
  const uploadLabel = uploadStatus === "success" || uploadStatus === "uploaded"
    ? "已上报"
    : uploadStatus === "failed" || uploadStatus === "retrying"
      ? "上报失败，等待重试"
      : "暂无上报回执";
  const uploadTone = uploadStatus === "success" || uploadStatus === "uploaded"
    ? "success"
    : uploadStatus === "failed" || uploadStatus === "retrying"
      ? "destructive"
      : "secondary";

  return {
    latestAtMs,
    routes: ROUTES.map(([key, label]) => {
      const sample = byRoute.get(key) ?? null;
      const status = effectiveStatus(sample);
      return { key, label, sample, statusLabel: labelForStatus(status), tone: toneForStatus(status) };
    }),
    uploadLabel,
    uploadTone,
      queuedCount: extended?.queuedCount ?? extended?.queueCount ?? 0,
    droppedCount: extended?.droppedCount ?? extended?.droppedSamples ?? 0,
  };
}

export function formatDiagnosticsTime(timestamp: number | null): string {
  if (timestamp === null) return "等待首次采样";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}
