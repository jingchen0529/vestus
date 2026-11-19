export type NetworkDiagnosticRoute = "management" | "vpn" | "browser";
export type NetworkDiagnosticMode = "direct" | "proxy" | "unavailable";
export type NetworkDiagnosticStatus = "ok" | "error";

export interface NetworkDiagnosticsItem {
  sampleId: string;
  userId: number;
  deviceId: string;
  route: NetworkDiagnosticRoute;
  targetKind: string;
  networkMode: NetworkDiagnosticMode;
  platformId?: string | null;
  browserId?: string | null;
  measuredAt: string;
  receivedAt: string;
  startedAtMs?: number | null;
  durationMs?: number | null;
  connectMs?: number | null;
  ttfbMs?: number | null;
  totalMs?: number | null;
  responseBytes?: number | null;
  downloadKbps?: number | null;
  status: NetworkDiagnosticStatus;
  errorCode?: string | null;
  clientVersion?: string | null;
}

export interface NetworkDiagnosticsSummary {
  p50?: number | null;
  p95?: number | null;
  p50Ms?: number | null;
  p95Ms?: number | null;
  failureRate?: number | null;
  count?: number;
}

export interface NetworkDiagnosticsResponse {
  items: NetworkDiagnosticsItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  summary: NetworkDiagnosticsSummary;
}

export interface NetworkDiagnosticsFilters {
  userId: string;
  deviceId: string;
  route: "ALL" | NetworkDiagnosticRoute;
  networkMode: "ALL" | NetworkDiagnosticMode;
  status: "ALL" | NetworkDiagnosticStatus;
  startAt: string;
  endAt: string;
}

export interface NetworkDiagnosticsQuery {
  page?: number;
  pageSize?: number;
  userId?: number;
  deviceId?: string;
  route?: NetworkDiagnosticRoute;
  networkMode?: NetworkDiagnosticMode;
  status?: NetworkDiagnosticStatus;
  startAt?: string;
  endAt?: string;
}

export const EMPTY_NETWORK_DIAGNOSTICS_FILTERS: NetworkDiagnosticsFilters = {
  userId: "ALL", deviceId: "", route: "ALL", networkMode: "ALL", status: "ALL", startAt: "", endAt: "",
};

export function toNetworkDiagnosticsQuery(filters: NetworkDiagnosticsFilters): Omit<NetworkDiagnosticsQuery, "page" | "pageSize"> {
  return {
    userId: filters.userId === "ALL" ? undefined : Number(filters.userId),
    deviceId: filters.deviceId.trim() || undefined,
    route: filters.route === "ALL" ? undefined : filters.route,
    networkMode: filters.networkMode === "ALL" ? undefined : filters.networkMode,
    status: filters.status === "ALL" ? undefined : filters.status,
    startAt: filters.startAt || undefined,
    endAt: filters.endAt || undefined,
  };
}

export function networkDiagnosticsPageAfterFilterChange(currentPage: number, changed: boolean): number {
  return changed ? 1 : currentPage;
}
