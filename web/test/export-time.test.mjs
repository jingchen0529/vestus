import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// 让测试机器的时区远离北京时间：导出结果不允许随本机时区变化。
process.env.TZ = "America/New_York";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  appType: "custom",
  configFile: false,
  root: webRoot,
  resolve: {
    alias: {
      "@": path.join(webRoot, "src"),
    },
  },
  server: {
    hmr: false,
    middlewareMode: true,
    ws: false,
  },
});

after(async () => {
  await server.close();
});

test("导出时间按北京时间呈现，且不带 ISO 的 T/Z 写法", async () => {
  const { formatBeijingDateTime, beijingDateStamp } = await server.ssrLoadModule(
    "/src/lib/utils.ts",
  );

  assert.equal(formatBeijingDateTime("2026-10-19T06:30:00Z"), "2026-10-19 14:30:00");
  // 跨日：UTC 还是 18 号，北京已经是 19 号。
  assert.equal(formatBeijingDateTime("2026-10-18T20:00:00Z"), "2026-10-19 04:00:00");
  // 北京午夜不能出现 24:00:00。
  assert.equal(formatBeijingDateTime("2026-10-18T16:00:00Z"), "2026-10-19 00:00:00");
  // 不带时区标记的值按 UTC 解释，而不是机器本地时间。
  assert.equal(formatBeijingDateTime("2026-10-19 06:30:00"), "2026-10-19 14:30:00");
  assert.equal(formatBeijingDateTime(""), "");
  assert.equal(formatBeijingDateTime(null), "");
  assert.equal(formatBeijingDateTime("不是时间"), "不是时间");

  assert.equal(beijingDateStamp(new Date("2026-10-18T20:00:00Z")), "2026-10-19");
});

test("CSV 与 JSON 导出对时间字段统一应用北京时间格式", async () => {
  const { buildCsvContent, withBeijingDateTimes } = await server.ssrLoadModule(
    "/src/lib/export-utils.ts",
  );
  const { formatBeijingDateTime } = await server.ssrLoadModule("/src/lib/utils.ts");

  const headers = [
    { label: "日志编号", key: "id" },
    { label: "操作时间", key: "createdAt", format: formatBeijingDateTime },
  ];
  const csv = buildCsvContent(headers, [
    { id: 1, createdAt: "2026-10-19T06:30:00Z" },
    { id: 2, createdAt: null },
  ]);
  assert.match(csv, /"2026-10-19 14:30:00"/);
  assert.doesNotMatch(csv, /T06:30:00Z/);
  assert.match(csv, /"2",""$/m);

  const rows = withBeijingDateTimes(
    [
      { id: 1, createdAt: "2026-10-19T06:30:00Z", startedAt: "2026-10-18T20:00:00Z", note: "keep" },
      { id: 2, createdAt: null, startedAt: "2026-10-19T00:00:00Z" },
    ],
    ["createdAt", "startedAt"],
  );
  assert.deepEqual(rows[0], {
    id: 1,
    createdAt: "2026-10-19 14:30:00",
    startedAt: "2026-10-19 04:00:00",
    note: "keep",
  });
  assert.deepEqual(rows[1], {
    id: 2,
    createdAt: null,
    startedAt: "2026-10-19 08:00:00",
  });
});
