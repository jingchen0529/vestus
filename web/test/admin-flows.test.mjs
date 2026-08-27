import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  appType: "custom",
  configFile: false,
  root: webRoot,
  plugins: [react()],
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

test("配置桌面导航保留被点击的目标用户", async () => {
  const appModule = await server.ssrLoadModule("/src/App.tsx");

  assert.equal(typeof appModule.getDesktopConfigNavigation, "function");
  assert.deepEqual(appModule.getDesktopConfigNavigation({ id: 42 }), {
    tab: "desktop",
    selectedUserId: 42,
  });
});

test("用户桌面配置保存时保留所选代理和平台", async () => {
  const cardModule = await server.ssrLoadModule(
    "/src/components/desktop-config/user-config-card.tsx",
  );

  assert.equal(typeof cardModule.buildDesktopConfigSelection, "function");
  assert.deepEqual(cardModule.buildDesktopConfigSelection("8", [12, 5]), {
    proxyId: 8,
    platformIds: [12, 5],
  });
});

test("编辑 locked 用户且未改状态时不会提交 active", async () => {
  const dialogModule = await server.ssrLoadModule(
    "/src/components/users/user-dialog.tsx",
  );

  assert.equal(typeof dialogModule.buildUserUpdatePayload, "function");
  assert.deepEqual(
    dialogModule.buildUserUpdatePayload(
      { status: "locked" },
      {
        name: " Locked User ",
        company: "",
        phone: " 13800000000 ",
        expiresAt: "",
        maxSessions: 2,
        remark: "",
        status: "locked",
      },
    ),
    {
      name: "Locked User",
      company: null,
      phone: "13800000000",
      expiresAt: null,
      maxSessions: 2,
      remark: null,
    },
  );
});

test("编辑用户明确改变状态时提交新状态", async () => {
  const dialogModule = await server.ssrLoadModule(
    "/src/components/users/user-dialog.tsx",
  );

  assert.equal(typeof dialogModule.buildUserUpdatePayload, "function");
  const payload = dialogModule.buildUserUpdatePayload(
    { status: "active" },
    {
      name: "User",
      company: "Company",
      phone: "",
      expiresAt: "2026-12-31",
      maxSessions: 3,
      remark: "note",
      status: "disabled",
    },
  );

  assert.equal(payload.status, "disabled");
});

test("审计日志详情读取后端 details 字段", async () => {
  const modalModule = await server.ssrLoadModule(
    "/src/components/logs/log-detail-modal.tsx",
  );

  assert.equal(typeof modalModule.getLogDetails, "function");
  assert.deepEqual(
    modalModule.getLogDetails({
      details: { source: "backend" },
      detail: { source: "legacy-front-end-name" },
    }),
    { source: "backend" },
  );
});

test("审计日志列表不发送后端不支持的 search 参数", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({ items: [], total: 0, page: 2, pageSize: 50 }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    await api.listLogs({
      page: 2,
      pageSize: 50,
      status: "FAILED",
      search: "ignored by backend",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestedUrl,
    "/api/admin/user-logs?page=2&pageSize=50&status=FAILED",
  );
});

test("品牌图片只接受服务端返回的上传半路径", async () => {
  const { requireStoredUploadPath } = await server.ssrLoadModule(
    "/src/lib/upload-paths.ts",
  );

  assert.equal(
    requireStoredUploadPath({
      path: "/uploads/2026/08/0123456789abcdef0123456789abcdef.png",
      url: "https://admin.example.com/uploads/2026/08/0123456789abcdef0123456789abcdef.png",
    }),
    "/uploads/2026/08/0123456789abcdef0123456789abcdef.png",
  );
  assert.throws(() => requireStoredUploadPath({ path: "https://evil.test/a.png" }));
  assert.throws(() => requireStoredUploadPath({ path: "data:image/png;base64,AA==" }));
});

test("品牌图片拒绝 SVG 和伪装的图片类型", async () => {
  const { validateBrandImage } = await server.ssrLoadModule(
    "/src/lib/upload-paths.ts",
  );

  assert.equal(validateBrandImage({ type: "image/png", size: 1024 }), null);
  assert.match(
    validateBrandImage({ type: "image/svg+xml", size: 1024 }),
    /PNG/,
  );
  assert.match(
    validateBrandImage({ type: "application/octet-stream", size: 1024 }),
    /PNG/,
  );
  assert.match(
    validateBrandImage({ type: "image/png", size: 2 * 1024 * 1024 + 1 }),
    /2MB/,
  );
});
