import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

test("代理管理只展示全局单代理规则，不再展示用户分配控件", async () => {
  const { DesktopConfigView } = await server.ssrLoadModule(
    "/src/components/desktop-config/desktop-config-view.tsx",
  );
  const html = renderToStaticMarkup(
    createElement(DesktopConfigView, {
      proxies: [],
      onRefresh() {},
      async onCreateProxy() {},
      async onUpdateProxy() {},
      async onToggleProxyStatus() {},
      async onDeleteProxy() {},
    }),
  );

  assert.doesNotMatch(html, /目标桌面端用户/);
  assert.doesNotMatch(html, /分配可访问平台/);
  assert.match(html, /全局最多启用一条代理/);
});

test("用户列表不再提供按用户配置代理和平台的入口", async () => {
  const { UserTable } = await server.ssrLoadModule(
    "/src/components/users/user-table.tsx",
  );
  const html = renderToStaticMarkup(
    createElement(UserTable, {
      users: [
        {
          id: 42,
          username: "shared-user",
          name: "Shared User",
          status: "active",
          maxSessions: 1,
        },
      ],
      onEditUser() {},
      onToggleStatus() {},
      onResetPassword() {},
      onDeleteUser() {},
    }),
  );

  assert.doesNotMatch(html, /配置桌面/);
  assert.doesNotMatch(html, /配置专属代理与平台/);
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
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: { items: [], total: 0, page: 2, pageSize: 50 },
        requestId: "test-request-id",
      }),
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

test("公共品牌清空 Logo 时同步清除旧缓存", async () => {
  const { syncPublicBranding } = await server.ssrLoadModule(
    "/src/hooks/use-theme.tsx",
  );
  assert.equal(typeof syncPublicBranding, "function");

  const values = new Map([
    ["title", "旧管理后台"],
    ["logo", "/uploads/old-logo.png"],
    ["accent", "red"],
  ]);
  const storage = {
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };

  const branding = syncPublicBranding(
    {
      adminTitle: "新管理后台",
      adminLogoUrl: "",
      logoUrl: "",
      adminThemeColor: "blue",
    },
    storage,
    { title: "title", logo: "logo", accent: "accent" },
  );

  assert.deepEqual(branding, {
    adminTitle: "新管理后台",
    adminLogoUrl: "",
    adminThemeColor: "blue",
  });
  assert.deepEqual(Object.fromEntries(values), {
    title: "新管理后台",
    accent: "blue",
  });
});

test("浏览器会话列表把筛选条件翻成查询参数，直连和走代理都能单独筛", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const { EMPTY_BROWSER_SESSION_FILTERS, toBrowserSessionQuery } =
    await server.ssrLoadModule("/src/types/browser-activity.ts");
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: { items: [], total: 0, page: 1, pageSize: 50, pages: 0 },
        requestId: "test-request-id",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    await api.listBrowserSessions({
      page: 3,
      pageSize: 20,
      ...toBrowserSessionQuery({
        userId: "7",
        platformId: "2",
        connection: "DIRECT",
        startAt: "2026-08-01",
        endAt: "2026-08-31",
      }),
    });
    await api.listBrowserSessions(
      toBrowserSessionQuery({ ...EMPTY_BROWSER_SESSION_FILTERS, connection: "PROXY" }),
    );
    await api.listBrowserSessions(toBrowserSessionQuery(EMPTY_BROWSER_SESSION_FILTERS));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestedUrls[0],
    "/api/admin/browser-sessions?page=3&pageSize=20&userId=7&platformId=2&directMode=true&startAt=2026-08-01&endAt=2026-08-31",
  );
  // 走代理是 directMode=false，不能因为它是假值就被当成"不筛"漏掉。
  assert.equal(requestedUrls[1], "/api/admin/browser-sessions?page=1&pageSize=50&directMode=false");
  assert.equal(requestedUrls[2], "/api/admin/browser-sessions?page=1&pageSize=50");
});

test("浏览器会话表格标出客户端漏记过地址的会话", async () => {
  const { SessionTable } = await server.ssrLoadModule(
    "/src/components/activity/session-table.tsx",
  );
  const proxied = {
    id: 1,
    userId: 7,
    username: "op01",
    sessionKey: "session-key-1",
    browserId: 3,
    platformId: 2,
    platformName: "站点 A",
    directMode: false,
    pageCount: 4,
    visits: 10,
    clicks: 20,
    inputs: 3,
    submits: 1,
    scrolls: 12,
    dwellMs: 3_723_000,
    droppedPages: 0,
    ipAddress: "10.0.0.9",
    startedAt: "2026-08-30T02:00:00Z",
    lastReportAt: "2026-08-30T02:30:00Z",
  };
  const html = renderToStaticMarkup(
    createElement(SessionTable, {
      sessions: [proxied, { ...proxied, id: 2, directMode: true, droppedPages: 5 }],
      onViewDetail() {},
    }),
  );

  assert.match(html, /代理/);
  assert.match(html, /直连/);
  assert.match(html, /1 小时 2 分/);
  // 只有 droppedPages > 0 的那一行才该带警告
  assert.equal(html.match(/不完整/g).length, 1);
});

test("浏览器会话地址明细独立展示参数且折叠快照不预渲染", async () => {
  const { PageActivityMeta, PageAddress } = await server.ssrLoadModule(
    "/src/components/activity/session-detail-modal.tsx",
  );
  const { formatDate } = await server.ssrLoadModule("/src/lib/utils.ts");

  assert.equal(typeof PageActivityMeta, "function");
  assert.equal(typeof PageAddress, "function");
  const withSnapshots = renderToStaticMarkup(
    createElement(PageAddress, {
      pageItem: {
        id: 1,
        url: "https://shop.example.test/orders",
        visits: 1,
        clicks: 0,
        inputs: 1,
        submits: 1,
        scrolls: 0,
        dwellMs: 0,
        urlParams: "customer=<script>alert('x')</script>&source=campaign",
        inputSnapshot: { name: ["snapshot-only-marker"] },
        inputSnapshotAt: "2026-09-01T10:00:00Z",
        submitSnapshot: { orderId: ["A-100"] },
        submitSnapshotAt: "2026-09-01T10:01:00Z",
      },
    }),
  );
  const emptyMeta = renderToStaticMarkup(
    createElement(PageActivityMeta, {
      pageItem: {
        id: 2,
        url: "https://shop.example.test/orders",
        visits: 1,
        clicks: 0,
        inputs: 0,
        submits: 0,
        scrolls: 0,
        dwellMs: 0,
        urlParams: "   ",
        inputSnapshot: { blank: [] },
        submitSnapshot: {},
      },
    }),
  );

  assert.match(withSnapshots, />https:\/\/shop\.example\.test\/orders</);
  assert.doesNotMatch(withSnapshots, /orders\?/);
  assert.match(withSnapshots, /地址参数/);
  assert.match(withSnapshots, /customer=&lt;script&gt;alert/);
  assert.doesNotMatch(withSnapshots, /<script>alert/);
  assert.match(withSnapshots, /客户输入快照/);
  assert.match(withSnapshots, /提交内容快照/);
  assert.ok(withSnapshots.includes(formatDate("2026-09-01T10:00:00Z")));
  assert.ok(withSnapshots.includes(formatDate("2026-09-01T10:01:00Z")));
  assert.doesNotMatch(withSnapshots, /snapshot-only-marker/);
  assert.doesNotMatch(emptyMeta, /地址参数|客户输入快照|提交内容快照/);
});

test("前台停留时长最多显示两级单位", async () => {
  const { formatDuration } = await server.ssrLoadModule("/src/lib/utils.ts");

  assert.equal(formatDuration(0), "—");
  assert.equal(formatDuration(undefined), "—");
  assert.equal(formatDuration(45_000), "45 秒");
  assert.equal(formatDuration(600_000), "10 分");
  assert.equal(formatDuration(605_000), "10 分 5 秒");
  assert.equal(formatDuration(3_723_000), "1 小时 2 分");
  assert.equal(formatDuration(7_200_000), "2 小时");
});

test("浏览器会话表格标出客户端版本号", async () => {
  const { SessionTable } = await server.ssrLoadModule(
    "/src/components/activity/session-table.tsx",
  );

  const html = renderToStaticMarkup(
    createElement(SessionTable, {
      sessions: [
        {
          id: 1,
          userId: 10,
          username: "desktop_user_a",
          sessionKey: "session-key-1",
          browserId: 101,
          platformId: 2,
          platformName: "电商平台",
          directMode: false,
          clientVersion: "0.2.2",
          pageCount: 3,
          visits: 5,
          clicks: 10,
          inputs: 2,
          submits: 1,
          scrolls: 20,
          dwellMs: 120000,
          droppedPages: 0,
          startedAt: "2026-09-01T10:00:00Z",
          lastReportAt: "2026-09-01T10:05:00Z",
        },
      ],
      onViewDetail: () => {},
    }),
  );

  assert.match(html, /v0\.2\.2/);
  assert.match(html, /desktop_user_a/);
});

test("会话追踪筛选栏包含重置按钮且日期输入框具备合适宽度", async () => {
  const { ActivityView } = await server.ssrLoadModule(
    "/src/components/activity/activity-view.tsx",
  );

  const html = renderToStaticMarkup(
    createElement(ActivityView, {
      sessions: [],
      totalSessions: 0,
      currentPage: 1,
      pageSize: 50,
      onPageChange() {},
      filters: {
        userId: "10",
        platformId: "ALL",
        connection: "ALL",
        startAt: "2026-09-01",
        endAt: "2026-09-02",
      },
      onFiltersChange() {},
      users: [],
      platforms: [],
      onRefresh() {},
      onLoadDetail: async () => ({ id: 1, pages: [] }),
    }),
  );

  assert.match(html, /重置/);
  assert.match(html, /2026-09-01/);
  assert.match(html, /2026-09-02/);
});

test("页码条只留当前页附近三页，两端补首末页", async () => {
  const { getPageItems } = await server.ssrLoadModule("/src/lib/pagination.ts");

  // 五页以内全列出来，没有省略号。
  assert.deepEqual(getPageItems(1, 3), [1, 2, 3]);
  assert.deepEqual(getPageItems(3, 5), [1, 2, 3, 4, 5]);

  assert.deepEqual(getPageItems(1, 9), [1, 2, 3, "ellipsis-end", 9]);
  assert.deepEqual(getPageItems(5, 9), [1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 9]);
  assert.deepEqual(getPageItems(9, 9), [1, "ellipsis-start", 7, 8, 9]);

  // 挨着首页/末页时不插省略号：那个位置放「...」比写出被它挡住的那一页还宽。
  assert.deepEqual(getPageItems(3, 6), [1, 2, 3, 4, "ellipsis-end", 6]);
  assert.deepEqual(getPageItems(4, 6), [1, "ellipsis-start", 3, 4, 5, 6]);
});

test("会话追踪与审计日志的页码条渲染出可点的页码按钮", async () => {
  const { ActivityView } = await server.ssrLoadModule(
    "/src/components/activity/activity-view.tsx",
  );

  const html = renderToStaticMarkup(
    createElement(ActivityView, {
      sessions: [],
      totalSessions: 96,
      currentPage: 5,
      pageSize: 10,
      onPageChange() {},
      filters: {
        userId: "ALL",
        platformId: "ALL",
        connection: "ALL",
        startAt: "",
        endAt: "",
      },
      onFiltersChange() {},
      users: [],
      platforms: [],
      onRefresh() {},
      onLoadDetail: async () => ({ id: 1, pages: [] }),
    }),
  );

  assert.match(html, /第一页/);
  assert.match(html, /最后一页/);
  assert.match(html, />4</);
  assert.match(html, />6</);
  assert.match(html, /\.\.\./);
  assert.match(html, /共 <strong[^>]*>96<\/strong> 条记录/);
});
