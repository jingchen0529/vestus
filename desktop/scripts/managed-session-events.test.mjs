import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function statusHandler(app) {
  const start = app.indexOf(".onStatusChange");
  const end = app.indexOf(".then((unlisten) => {", start);
  return app.slice(start, end);
}

test("late ignored managed reports must not resync and close newly opened browsers", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const handler = app.slice(
    app.indexOf(".onManagedSessionExpired"),
    app.indexOf("unlistenExpiredFn = unlisten"),
  );
  assert.match(handler, /payload\.reported && payload\.applied/);
  assert.match(handler, /未影响新凭据/);
  assert.match(handler, /!payload\.browserClosed/);
  assert.match(handler, /!payload\.reported/);
});

test("lease changes auto-resync the desktop config without manual refresh", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const handler = statusHandler(app);
  assert.match(handler, /desktop_config_changed/);
  // 自动重同步在前；只有重同步失败才降级为需要人工处理的旧提示。
  assert.match(handler, /await syncDesktopConfig\(false\)/);
  assert.match(handler, /配置已自动同步/);
  const tail = handler.slice(handler.indexOf("desktop_config_changed"));
  const syncAt = tail.indexOf("await syncDesktopConfig(false)");
  const fallbackAt = tail.indexOf("请重新同步后继续使用");
  assert.ok(syncAt !== -1 && fallbackAt !== -1 && syncAt < fallbackAt);
});
