import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const card = await readFile(path.join(root, "src/components/network/NetworkDiagnosticsCard.tsx"), "utf8");
const view = await readFile(path.join(root, "src/components/network/networkDiagnosticsView.ts"), "utf8");
const app = await readFile(path.join(root, "src/App.tsx"), "utf8");
const launcher = await readFile(path.join(root, "src/components/browser/PlatformLauncher.tsx"), "utf8");
const settings = await readFile(path.join(root, "src/components/settings/SystemSettings.tsx"), "utf8");

test("网络诊断卡覆盖空态、采样中和三条链路", () => {
  assert.match(card, /等待首次采样/);
  assert.match(card, /采样中/);
  assert.match(view, /管理端/);
  assert.match(view, /VPN 代理/);
  assert.match(view, /浏览器 CDP/);
  assert.match(view, /代理认证失败/);
  assert.match(view, /CDP 不可用/);
  assert.match(view, /上报失败，等待重试/);
});

test("卡片只消费快照，不提供第二个测速入口", () => {
  assert.doesNotMatch(card, /fetch\s*\(|invoke\s*\(/);
  assert.doesNotMatch(card, /startNetworkDiagnostics/);
  assert.match(card, /不会发起额外测速请求/);
});

test("宽窄布局都保留三条链路和时间信息", () => {
  assert.match(card, /grid-cols-1 gap-2 min-\[520px\]:grid-cols-3/);
  assert.match(card, /最近采样/);
});

test("登录后订阅诊断事件并在两个入口复用同一快照", () => {
  assert.match(app, /getNetworkDiagnostics\(\)/);
  assert.match(app, /onNetworkDiagnosticsChange\(/);
  assert.match(app, /unlistenNetworkDiagnostics/);
  assert.match(launcher, /NetworkDiagnosticsCard/);
  assert.match(settings, /NetworkDiagnosticsCard/);
});
