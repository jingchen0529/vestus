import { NetworkDiagnosticsFilters, NetworkDiagnosticsResponse } from "@/types/network-diagnostics";

export function networkDiagnosticsFilterState(filters: NetworkDiagnosticsFilters, next: NetworkDiagnosticsFilters) {
  void filters;
  return { filters: next, page: 1 };
}

export function networkDiagnosticsFailureState(previous: NetworkDiagnosticsResponse, error: string): { data: NetworkDiagnosticsResponse; error: string } {
  return {
    data: { ...previous, items: [], total: 0, pages: 0, summary: {} },
    error,
  };
}

export const emptyNetworkDiagnosticsResponse: NetworkDiagnosticsResponse = {
  items: [], total: 0, page: 1, pageSize: 50, pages: 0, summary: {},
};
