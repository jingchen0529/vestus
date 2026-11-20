import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const card = await readFile(path.join(root, "src/components/network/NetworkDiagnosticsCard.tsx"), "utf8");
const viewSource = await readFile(path.join(root, "src/components/network/networkDiagnosticsView.ts"), "utf8");
const app = await readFile(path.join(root, "src/App.tsx"), "utf8");
const launcher = await readFile(path.join(root, "src/components/browser/PlatformLauncher.tsx"), "utf8");
const bridge = await readFile(path.join(root, "src/services/tauriBridge.ts"), "utf8");
const settings = await readFile(path.join(root, "src/components/settings/SystemSettings.tsx"), "utf8");

const { outputText } = ts.transpileModule(viewSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const {
  formatCompactUploadSummary,
  formatDiagnosticsTimestampLabel,
  toNetworkDiagnosticsView,
} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("网络诊断卡覆盖空态、采样中和有效链路", () => {
  assert.match(viewSource, /等待首次采样/);
  assert.match(card, /采样中/);
  assert.match(viewSource, /管理端/);
  assert.match(viewSource, /VPN 代理/);
  assert.match(viewSource, /浏览器 CDP/);
  assert.match(viewSource, /代理认证失败/);
  assert.match(viewSource, /CDP 不可用/);
  assert.match(viewSource, /上报失败，等待重试/);
  assert.match(viewSource, /DNS 解析失败/);
  assert.match(viewSource, /TLS 连接失败/);
  assert.match(viewSource, /网络诊断失败/);

  const empty = toNetworkDiagnosticsView(null);
  assert.equal(formatDiagnosticsTimestampLabel(empty.latestAtMs), "等待首次采样");
  assert.deepEqual(
    empty.routes.map((route) => [route.label, route.statusLabel, route.tone]),
    [
      ["管理端", "暂无采样", "secondary"],
      ["VPN 代理", "暂无采样", "secondary"],
    ],
  );
  assert.equal(formatCompactUploadSummary(empty), "暂无上报回执");
});

test("视图模型正确映射延迟、异常与紧凑上报摘要", () => {
  const healthy = toNetworkDiagnosticsView({
    samples: [
      { sampleId: "1", route: "management", targetKind: "api", networkMode: "direct", startedAtMs: 1700000000000, durationMs: 73, status: "ok" },
      { sampleId: "2", route: "vpn", targetKind: "proxy_probe", networkMode: "proxy", startedAtMs: 1700000001000, durationMs: 200, status: "ok" },
      { sampleId: "3", route: "browser", targetKind: "cdp", networkMode: "proxy", startedAtMs: 1700000002000, durationMs: 2, status: "ok" },
    ],
    queuedCount: 8,
    droppedCount: 0,
  });
  assert.match(formatDiagnosticsTimestampLabel(healthy.latestAtMs), /^最近采样 \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatCompactUploadSummary(healthy), "待上报 8");

  const uploaded = toNetworkDiagnosticsView({
    samples: [],
    uploadStatus: "uploaded",
    queuedCount: 0,
    droppedCount: 0,
  });
  assert.equal(formatCompactUploadSummary(uploaded), "已上报");

  const failed = toNetworkDiagnosticsView({
    samples: [
      { sampleId: "4", route: "vpn", targetKind: "proxy_probe", networkMode: "unavailable", startedAtMs: 1700000003000, durationMs: 120, status: "error", errorCode: "proxy_auth" },
      { sampleId: "5", route: "browser", targetKind: "cdp", networkMode: "proxy", startedAtMs: 1700000003000, status: "error", errorCode: "cdp_unavailable" },
    ],
    uploadStatus: "retrying",
    queuedCount: 12,
    droppedCount: 2,
  });
  assert.deepEqual(failed.routes.map((route) => route.key), ["management", "vpn"]);
  const failedVpn = failed.routes.find((route) => route.key === "vpn");
  assert.ok(failedVpn);
  assert.equal(failedVpn.statusLabel, "代理认证失败");
  assert.equal(failedVpn.tone, "destructive");
  assert.equal(formatCompactUploadSummary(failed), "上报失败，等待重试");

  const droppedOnly = toNetworkDiagnosticsView({
    samples: [],
    uploadStatus: "uploaded",
    queuedCount: 5,
    droppedCount: 3,
  });
  assert.equal(formatCompactUploadSummary(droppedOnly), "待上报 5 · 丢弃 3");
});

test("卡片只消费快照，不提供第二个测速入口", () => {
  assert.doesNotMatch(card, /fetch\s*\(|invoke\s*\(/);
  assert.doesNotMatch(card, /startNetworkDiagnostics/);
  assert.match(card, /queuedCount|待上报/);
  assert.match(card, /droppedCount|丢弃/);
  assert.match(card, /不会发起额外测速请求/);
});

test("宽窄布局都保留三条链路和时间信息，且平台入口启用紧凑模式", () => {
  assert.match(card, /compactRouteGridClass/);
  assert.match(card, /defaultRouteGridClass/);
  assert.match(card, /data-variant="compact"/);
  assert.match(card, /formatDiagnosticsTimestampLabel/);
  assert.match(launcher, /<NetworkDiagnosticsCard[\s\S]*compact[\s\S]*\/>/);
});

test("登录后订阅诊断事件并在两个入口复用同一快照", () => {
  assert.match(app, /getNetworkDiagnostics\(\)/);
  assert.match(app, /onNetworkDiagnosticsChange\(/);
  assert.match(app, /unlistenNetworkDiagnostics/);
  assert.match(app, /startNetworkDiagnostics\(\)/);
  assert.match(app, /stopNetworkDiagnostics\(\)/);
  assert.match(launcher, /NetworkDiagnosticsCard/);
  assert.match(settings, /NetworkDiagnosticsCard/);
  assert.match(bridge, /uploadStatus/);
  assert.match(bridge, /queuedCount/);
  assert.match(bridge, /droppedCount/);
});
