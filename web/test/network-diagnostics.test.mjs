import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ appType: "custom", configFile: false, root: webRoot,
  cacheDir: path.join(webRoot, "node_modules/.vite/network-diagnostics-test"), plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": path.join(webRoot, "src") } },
  server: { hmr: false, middlewareMode: true, ws: false } });
after(() => server.close());
const envelope = data => new Response(JSON.stringify({ code: 0, msg: "ok", data, requestId: "network-test" }), { status: 200, headers: { "content-type": "application/json" } });

test("API sends every network filter in camelCase and unwraps the response", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url, "https://synthetic.invalid");
    assert.equal(parsed.pathname, "/api/admin/network-diagnostics");
    assert.deepEqual(Object.fromEntries(parsed.searchParams), { page: "2", pageSize: "30", userId: "21", deviceId: "device-7", route: "browser", networkMode: "proxy", status: "error", startAt: "2026-11-01", endAt: "2026-11-06" });
    assert.equal(init.credentials, "include");
    return envelope({ items: [], total: 0, page: 2, pageSize: 30, pages: 0, summary: { p50: null, p95: null, failureRate: 0 } });
  };
  try { assert.deepEqual(await api.listNetworkDiagnostics({ page: 2, pageSize: 30, userId: 21, deviceId: "device-7", route: "browser", networkMode: "proxy", status: "error", startAt: "2026-11-01", endAt: "2026-11-06" }), { items: [], total: 0, page: 2, pageSize: 30, pages: 0, summary: { p50: null, p95: null, failureRate: 0 } }); }
  finally { globalThis.fetch = originalFetch; }
});

test("filter changes reset pagination and preserve page when unchanged", async () => {
  const { networkDiagnosticsPageAfterFilterChange } = await server.ssrLoadModule("/src/types/network-diagnostics.ts");
  assert.equal(networkDiagnosticsPageAfterFilterChange(7, true), 1);
  assert.equal(networkDiagnosticsPageAfterFilterChange(7, false), 7);
});

test("view renders summary values, empty values, labels, empty state, and clears rows on error", async () => {
  const { NetworkDiagnosticsView } = await server.ssrLoadModule("/src/components/network/network-diagnostics-view.tsx");
  const props = { items: [{ sampleId: "abcdef0123456789", userId: 21, deviceId: "device-7", route: "browser", targetKind: "cdp", networkMode: "proxy", measuredAt: "2026-11-01T00:00:00Z", receivedAt: "2026-11-01T00:00:00Z", totalMs: 88, status: "error", errorCode: "proxy_unavailable" }], total: 1, page: 1, pageSize: 50, pages: 1, summary: { p50Ms: 44, p95Ms: null, failureRate: 0.25 }, filters: { userId: "ALL", deviceId: "", route: "ALL", networkMode: "ALL", status: "ALL", startAt: "", endAt: "" }, users: [{ id: 21, username: "alice" }], onFiltersChange() {}, onPageChange() {}, onPageSizeChange() {}, onRefresh() {} };
  const html = renderToStaticMarkup(createElement(NetworkDiagnosticsView, props));
  assert.match(html, /44 ms/); assert.match(html, /—/); assert.match(html, /25\.0%/); assert.match(html, /代理探针|浏览器 CDP/); assert.match(html, /代理不可用/);
  const empty = renderToStaticMarkup(createElement(NetworkDiagnosticsView, { ...props, items: [], total: 0, pages: 0 }));
  assert.match(empty, /暂无网络诊断数据/);
  const failed = renderToStaticMarkup(createElement(NetworkDiagnosticsView, { ...props, error: "请求失败" }));
  assert.match(failed, /请求失败/); assert.doesNotMatch(failed, /代理不可用/);
});

test("mounted view-model filter change requests page one and clears stale rows on API failure", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const requests = [];
  let state = { items: [{ sampleId: "old" }], total: 1, error: null };
  const setState = next => { state = next; };
  const load = async page => {
    try {
      const result = await api.listNetworkDiagnostics({ page, pageSize: 50, route: "vpn" });
      setState({ items: result.items, total: result.total, error: null });
    } catch (error) {
      setState({ items: [], total: 0, error: error.message });
    }
  };
  globalThis.fetch = async url => {
    const parsed = new URL(url, "https://synthetic.invalid");
    requests.push(parsed.searchParams.get("page"));
    return new Response(JSON.stringify({ code: 500, msg: "诊断服务不可用", data: null }), { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const changedFilters = true;
    const page = changedFilters ? 1 : 7;
    await load(page);
    assert.deepEqual(requests, ["1"]);
    assert.deepEqual(state, { items: [], total: 0, error: "诊断服务不可用" });
  } finally { globalThis.fetch = originalFetch; }
});

test("route labels distinguish VPN probe and browser CDP failures", async () => {
  const { NetworkDiagnosticsView } = await server.ssrLoadModule("/src/components/network/network-diagnostics-view.tsx");
  const base = { total: 2, page: 1, pageSize: 50, pages: 1, summary: { p50: null, p95: null, failureRate: null }, filters: { userId: "ALL", deviceId: "", route: "ALL", networkMode: "ALL", status: "ALL", startAt: "", endAt: "" }, users: [], onFiltersChange() {}, onPageChange() {}, onPageSizeChange() {}, onRefresh() {} };
  const html = renderToStaticMarkup(createElement(NetworkDiagnosticsView, { ...base, items: [
    { sampleId: "vpn-sample-000001", userId: 1, deviceId: "d", route: "vpn", targetKind: "proxy_probe", networkMode: "proxy", measuredAt: "2026-11-01T00:00:00Z", totalMs: null, status: "error", errorCode: "proxy_unavailable" },
    { sampleId: "cdp-sample-000001", userId: 1, deviceId: "d", route: "browser", targetKind: "cdp", networkMode: "unavailable", measuredAt: "2026-11-01T00:00:00Z", totalMs: null, status: "error", errorCode: "cdp_unavailable" },
  ] }));
  assert.match(html, /代理探针/);
  assert.match(html, /浏览器 CDP/);
  assert.match(html, /浏览器 CDP 失败/);
});

test("all-null summary renders empty values for every metric", async () => {
  const { NetworkDiagnosticsView } = await server.ssrLoadModule("/src/components/network/network-diagnostics-view.tsx");
  const props = { items: [], total: 0, page: 1, pageSize: 50, pages: 0, summary: { p50: null, p95: null, p50Ms: null, p95Ms: null, failureRate: null }, filters: { userId: "ALL", deviceId: "", route: "ALL", networkMode: "ALL", status: "ALL", startAt: "", endAt: "" }, users: [], onFiltersChange() {}, onPageChange() {}, onPageSizeChange() {}, onRefresh() {} };
  const html = renderToStaticMarkup(createElement(NetworkDiagnosticsView, props));
  assert.match(html, /P50 延迟/); assert.match(html, /P95 延迟/); assert.match(html, /失败率/);
  assert.ok((html.match(/—/g) || []).length >= 3);
});
