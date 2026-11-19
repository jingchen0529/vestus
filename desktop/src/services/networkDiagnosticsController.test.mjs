import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./networkDiagnosticsController.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { createNetworkDiagnosticsController } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("successful config refreshes restart the monitor and refresh its snapshot without duplicate starts", async () => {
  const starts = [];
  const snapshots = [];
  let snapshotId = 0;
  const controller = createNetworkDiagnosticsController({
    start: async () => starts.push(starts.length + 1),
    getSnapshot: async () => ({ id: ++snapshotId }),
    stop: async () => {},
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  const first = controller.refresh();
  const duplicate = controller.refresh();
  await Promise.all([first, duplicate]);
  await controller.refresh();

  assert.deepEqual(starts, [1, 2], "overlapping refreshes share one start, later syncs start again");
  assert.deepEqual(snapshots, [{ id: 1 }, { id: 2 }]);
  controller.dispose();
});

test("disposing during start prevents a late start from publishing a snapshot", async () => {
  const started = deferred();
  const stops = [];
  const snapshots = [];
  const controller = createNetworkDiagnosticsController({
    start: () => started.promise,
    getSnapshot: async () => ({ id: 1 }),
    stop: async () => stops.push(true),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  const refresh = controller.refresh();
  controller.dispose();
  started.resolve();
  await refresh;

  assert.equal(stops.length, 1);
  assert.deepEqual(snapshots, []);
});

test("App refreshes diagnostics after every successful config sync and disposes on logout", () => {
  assert.match(appSource, /networkDiagnosticsRefreshRef\.current\?\.\(\)/);
  assert.match(appSource, /diagnostics\.dispose\(\)/);
});
