import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('../src/lib/api-client.ts', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../src/types/network-diagnostics.ts', import.meta.url), 'utf8');
const view = fs.readFileSync(new URL('../src/components/network/network-diagnostics-view.tsx', import.meta.url), 'utf8');

test('network diagnostics API uses the typed endpoint and camelCase filters', () => {
  assert.match(api, /listNetworkDiagnostics/);
  for (const key of ['userId', 'deviceId', 'networkMode', 'startAt', 'endAt']) assert.match(api, new RegExp(`"${key}"`));
  assert.match(types, /NetworkDiagnosticsResponse/);
});

test('network diagnostics view covers summary, pagination and failure states', () => {
  assert.match(view, /p50Ms/);
  assert.match(view, /p95Ms/);
  assert.match(view, /failureRate/);
  assert.match(view, /TablePagination/);
  assert.match(view, /暂无网络诊断数据/);
  assert.match(view, /translateNetworkError/);
  assert.match(view, /代理探针/);
  assert.match(view, /浏览器 CDP/);
});
