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

test("an invalidated refresh queues a new start when the previous snapshot is still pending", async () => {
  const firstSnapshot = deferred();
  const starts = [];
  let snapshotCalls = 0;
  const snapshots = [];
  const controller = createNetworkDiagnosticsController({
    start: async () => starts.push(starts.length + 1),
    getSnapshot: async () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? firstSnapshot.promise : { id: 2 };
    },
    stop: async () => {},
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  const first = controller.refresh();
  await new Promise(setImmediate);
  assert.deepEqual(starts, [1]);
  controller.invalidate();
  const queued = controller.refresh();
  assert.deepEqual(starts, [1], "the replacement waits for the old snapshot to settle");
  firstSnapshot.resolve({ id: 1 });
  await Promise.all([first, queued]);
  await new Promise(setImmediate);

  assert.deepEqual(starts, [1, 2]);
  assert.deepEqual(snapshots, [{ id: 2 }], "the stale snapshot is discarded before the replacement refresh");
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

test("invalidating a pending snapshot suppresses the old owner without restarting until requested", async () => {
  const pendingSnapshot = deferred();
  const starts = [];
  const snapshots = [];
  const controller = createNetworkDiagnosticsController({
    start: async () => starts.push(true),
    getSnapshot: () => pendingSnapshot.promise,
    stop: async () => {},
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  const refresh = controller.refresh();
  await new Promise(setImmediate);
  controller.invalidate();
  pendingSnapshot.resolve({ id: 1 });
  await refresh;

  assert.equal(starts.length, 1);
  assert.deepEqual(snapshots, []);
  controller.dispose();
});

test("a later logout invalidation cancels a queued replacement start", async () => {
  const pendingSnapshot = deferred();
  const starts = [];
  const controller = createNetworkDiagnosticsController({
    start: async () => starts.push(true),
    getSnapshot: () => pendingSnapshot.promise,
    stop: async () => {},
    onSnapshot: () => {},
  });

  const first = controller.refresh();
  await new Promise(setImmediate);
  controller.invalidate();
  const queued = controller.refresh();
  controller.invalidate();
  pendingSnapshot.resolve({ id: 1 });
  await Promise.all([first, queued]);
  await new Promise(setImmediate);

  assert.equal(starts.length, 1, "logout must cancel a queued restart");
  controller.dispose();
});

test("App refreshes diagnostics after every successful config sync and disposes on logout", () => {
  assert.match(appSource, /networkDiagnosticsRefreshRef\.current\?\.\(\)/);
  assert.match(appSource, /networkDiagnosticsInvalidateRef\.current\?\.\(\)/);
  assert.match(appSource, /diagnostics\.dispose\(\)/);
});
