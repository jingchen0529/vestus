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
  cacheDir: path.join(webRoot, "node_modules/.vite/admin-flows-test"),
  plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: [] },
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

test("代理管理展示多节点与默认节点规则，指向用户管理配置 VPN", async () => {
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
  assert.match(html, /多条代理可同时启用/);
  assert.match(html, /用户管理/);
  assert.match(html, /默认/);
});

test("托管平台账号列表只展示状态，不回显密码或 Cookie", async () => {
  const { ManagedPlatformsView } = await server.ssrLoadModule(
    "/src/components/managed-platforms/managed-platforms-view.tsx",
  );
  const html = renderToStaticMarkup(
    createElement(ManagedPlatformsView, {
      accounts: [
        {
          id: 7,
          platformId: 2,
          name: "方舟主账号",
          authMode: "cookie",
          allowedHosts: ["ark.example.test"],
          credentialVersion: 3,
          status: "active",
          lastVerifiedAt: "2026-11-02T01:00:00Z",
        },
      ],
      platforms: [{ id: 2, name: "方舟", url: "https://ark.example.test", sortOrder: 0, status: "active" }],
      users: [],
      onRefresh() {},
      onCreateAccount: async () => {},
      onUpdateAccount: async () => {},
      onVerifyAccount: async () => {},
      onBindAccount: async () => {},
    }),
  );

  assert.match(html, /方舟主账号/);
  assert.match(html, /已配置/);
  assert.match(html, /密码和 Cookie 不会回显/);
  assert.doesNotMatch(html, /secret-cookie|ark-password/);
});

test("托管平台账号 API 使用专用管理路径", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    requests.push({ url: String(input), method: options.method || "GET", body: options.body });
    const data = String(input).endsWith("/managed-platform-accounts")
      ? { items: [], total: 0 }
      : {};
    return new Response(JSON.stringify({ code: 0, msg: "ok", data, requestId: "test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await api.listManagedPlatformAccounts();
    await api.createManagedPlatformAccount({
      platformId: 2,
      name: "方舟主账号",
      authMode: "cookie",
      cookieBundle: [{ name: "sessionid", value: "secret", domain: ".example.test" }],
    });
    await api.bindManagedPlatformAccount(7, 9);
    await api.unbindManagedPlatformAccount(7, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map(({ url, method }) => [url, method]),
    [
      ["/api/admin/managed-platform-accounts", "GET"],
      ["/api/admin/managed-platform-accounts", "POST"],
      ["/api/admin/managed-platform-accounts/7/bindings", "POST"],
      ["/api/admin/managed-platform-accounts/7/bindings/9", "DELETE"],
    ],
  );
  assert.match(requests[1].body, /"cookieBundle"/);
});

test("用户托管账号支持按账号列出、绑定和解绑多个入口", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    requests.push({ url: String(input), method: options.method || "GET", body: options.body });
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: { items: [{ managedAccountId: 7, name: "账号 A" }, { managedAccountId: 8, name: "账号 B" }] },
      requestId: "test",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await api.listUserManagedAccounts(3);
    await api.bindUserManagedAccount(3, 8);
    await api.unbindUserManagedAccount(3, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map(({ url, method }) => [url, method]),
    [
      ["/api/admin/users/3/managed-accounts", "GET"],
      ["/api/admin/users/3/managed-accounts", "POST"],
      ["/api/admin/users/3/managed-accounts/7", "DELETE"],
    ],
  );
  assert.match(requests[1].body, /"managedAccountId":8/);
});

test("用户托管账号弹窗以 Table 表格展示多个绑定且不回显 Cookie", async () => {
  const { ManagedAccountBindingList } = await server.ssrLoadModule(
    "/src/components/users/managed-account-dialog.tsx",
  );
  const html = renderToStaticMarkup(
    createElement(ManagedAccountBindingList, {
      bindings: [
        { id: 1, userId: 3, platformId: 1, platformName: "方舟", managedAccountId: 7, name: "账号 A", authMode: "cookie", status: "active" },
        { id: 2, userId: 3, platformId: 1, platformName: "方舟", managedAccountId: 8, name: "账号 B", authMode: "server_login", status: "expired" },
      ],
      onEdit() {},
      onUnbind() {},
    }),
  );

  assert.match(html, /<table/);
  assert.match(html, /托管账号/);
  assert.match(html, /所属平台/);
  assert.match(html, /认证方式/);
  assert.match(html, /账号 A/);
  assert.match(html, /账号 B/);
  assert.match(html, /Cookie/);
  assert.match(html, /账号密码/);
  assert.match(html, /正常启用/);
  assert.match(html, /已过期/);
  assert.match(html, /编辑/);
  assert.match(html, /解除/);
  assert.doesNotMatch(html, /secret-cookie|cookie-secret/);
});

test("按用户创建、读取详情与更新单个绑定托管账号 API 路径正确", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, method: init.method || "GET", body: init.body || null });
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: { id: 7, managedAccountId: 7, platformId: 1, name: "张三-方舟1", authMode: "cookie", status: "active" },
        requestId: "test",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    await api.createUserManagedAccount(3, {
      name: "张三-方舟1",
      authMode: "cookie",
      cookieBundle: [{ name: "sid", value: "tok", domain: ".oceanengine.com" }],
    });
    await api.getUserManagedAccountDetail(3, 7);
    await api.updateUserManagedAccount(3, 7, { name: "张三-方舟主号" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map(({ url, method }) => [url, method]),
    [
      ["/api/admin/users/3/managed-accounts", "POST"],
      ["/api/admin/users/3/managed-accounts/7", "GET"],
      ["/api/admin/users/3/managed-accounts/7", "PATCH"],
    ],
  );
  assert.match(requests[0].body, /"name":"张三-方舟1"/);
  assert.match(requests[2].body, /"name":"张三-方舟主号"/);
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

test("用户列表展示指定 VPN 与绑定管理员列", async () => {
  const { UserTable } = await server.ssrLoadModule(
    "/src/components/users/user-table.tsx",
  );
  const html = renderToStaticMarkup(
    createElement(UserTable, {
      users: [
        {
          id: 42,
          username: "assigned-user",
          name: "Assigned User",
          status: "active",
          maxSessions: 1,
          proxyId: 7,
          proxyName: "北京节点",
          boundAdminId: 3,
          boundAdminName: "北京管理员",
        },
      ],
      onEditUser() {},
      onToggleStatus() {},
      onResetPassword() {},
      onDeleteUser() {},
    }),
  );

  assert.match(html, /指定 VPN/);
  assert.match(html, /绑定管理员/);
  assert.match(html, /北京节点/);
  assert.match(html, /单独指派/);
  assert.match(html, /北京管理员/);

  const fallbackHtml = renderToStaticMarkup(
    createElement(UserTable, {
      users: [
        {
          id: 43,
          username: "default-user",
          name: "Default User",
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
  assert.match(fallbackHtml, /默认节点/);
  assert.match(fallbackHtml, /跟随默认/);
  assert.match(fallbackHtml, /未绑定/);

  // 指派到已停用节点：名字还在，但要标出这条指派已经不生效。
  const lapsedHtml = renderToStaticMarkup(
    createElement(UserTable, {
      users: [
        {
          id: 44,
          username: "lapsed-user",
          name: "Lapsed User",
          status: "active",
          maxSessions: 1,
          proxyId: 9,
          proxyName: "已停用节点",
          proxyActive: false,
        },
      ],
      onEditUser() {},
      onToggleStatus() {},
      onResetPassword() {},
      onDeleteUser() {},
    }),
  );
  assert.match(lapsedHtml, /已停用节点/);
  assert.match(lapsedHtml, /指派已失效·回落默认/);
});

test("用户列表展示最近登录的设备码，未上报时明确标出", async () => {
  const { UserTable } = await server.ssrLoadModule(
    "/src/components/users/user-table.tsx",
  );
  const withDevice = renderToStaticMarkup(
    createElement(UserTable, {
      users: [
        {
          id: 51,
          username: "device-user",
          name: "Device User",
          status: "active",
          maxSessions: 1,
          lastDeviceId: "a1b2c3d4e5f67890abcdef1234567890",
        },
      ],
      onEditUser() {},
      onToggleStatus() {},
      onResetPassword() {},
      onDeleteUser() {},
    }),
  );
  assert.match(withDevice, /最近设备/);
  // 长机器码只显示尾部，完整值在 title 里。
  assert.match(withDevice, /…1234567890/);
  assert.match(withDevice, /title="a1b2c3d4e5f67890abcdef1234567890"/);

  const withoutDevice = renderToStaticMarkup(
    createElement(UserTable, {
      users: [
        {
          id: 52,
          username: "old-client-user",
          name: "Old Client",
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
  assert.match(withoutDevice, /未上报/);
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

test("会话追踪页码条提供 10/30/50/100 每页数量选择", async () => {
  const { ActivityView } = await server.ssrLoadModule(
    "/src/components/activity/activity-view.tsx",
  );

  const html = renderToStaticMarkup(
    createElement(ActivityView, {
      sessions: [],
      totalSessions: 96,
      currentPage: 1,
      pageSize: 50,
      onPageChange() {},
      onPageSizeChange() {},
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

  assert.match(html, /每页/);
  assert.match(html, /50 条/);
});

test("审计日志页码条提供 10/30/50/100 每页数量选择", async () => {
  const { LogsView } = await server.ssrLoadModule(
    "/src/components/logs/logs-view.tsx",
  );

  const html = renderToStaticMarkup(
    createElement(LogsView, {
      logs: [],
      totalLogs: 120,
      currentPage: 1,
      pageSize: 10,
      onPageChange() {},
      onPageSizeChange() {},
      statusFilter: "ALL",
      onStatusFilterChange() {},
      onRefresh() {},
    }),
  );

  assert.match(html, /每页/);
  assert.match(html, /10 条/);
});

test("按用户配置托管账号 API 使用用户专属路径并只提交认证凭据", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    requests.push({ url: String(input), method: options.method || "GET", body: options.body });
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: { platformId: 1, platformName: "方舟", authMode: "cookie", status: "active" },
      requestId: "test",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await api.getUserManagedAccount(42);
    await api.upsertUserManagedAccount(42, {
      authMode: "server_login",
      username: "ark-user",
      password: "ark-password",
    });
    await api.deleteUserManagedAccount(42);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map(({ url, method }) => [url, method]),
    [
      ["/api/admin/users/42/managed-account", "GET"],
      ["/api/admin/users/42/managed-account", "PUT"],
      ["/api/admin/users/42/managed-account", "DELETE"],
    ],
  );
  assert.equal(requests[1].body, JSON.stringify({
    authMode: "server_login",
    username: "ark-user",
    password: "ark-password",
  }));
  assert.doesNotMatch(requests[1].body, /"(?:expiresAt|allowedHosts|platformId|name)"/);
});

test("未绑定托管账号的 404 视为空配置而非错误", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 40400,
    msg: "该用户未绑定托管平台账号",
    data: null,
    requestId: "test",
  }), { status: 404, headers: { "content-type": "application/json" } });

  try {
    const result = await api.getUserManagedAccount(42);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("用户行仅向超级管理员展示绑定托管账号按钮", async () => {
  const { UserTable } = await server.ssrLoadModule("/src/components/users/user-table.tsx");
  const props = {
    users: [{ id: 42, username: "managed-user", name: "Managed User", status: "active", maxSessions: 1 }],
    onEditUser() {},
    onToggleStatus() {},
    onResetPassword() {},
    onDeleteUser() {},
    onManageManagedAccount() {},
  };

  const superAdminHtml = renderToStaticMarkup(createElement(UserTable, {
    ...props,
    canManageManagedAccount: true,
  }));
  assert.match(superAdminHtml, /绑定托管账号/);

  const plainAdminHtml = renderToStaticMarkup(createElement(UserTable, {
    ...props,
    canManageManagedAccount: false,
  }));
  assert.doesNotMatch(plainAdminHtml, /绑定托管账号/);
});

test("托管账号表单只保留认证方式和对应凭据", async () => {
  const dialogModule = await server.ssrLoadModule("/src/components/users/managed-account-dialog.tsx");
  assert.equal(typeof dialogModule.buildManagedAccountPayload, "function");
  assert.deepEqual(
    dialogModule.buildManagedAccountPayload({
      authMode: "server_login",
      username: " ark-user ",
      password: "ark-password",
      cookieJson: "",
    }),
    { authMode: "server_login", username: "ark-user", password: "ark-password" },
  );
  assert.deepEqual(
    dialogModule.buildManagedAccountPayload({
      authMode: "cookie",
      username: "",
      password: "",
      cookieJson: '[{"name":"sessionid","value":"secret","domain":".ark.test"}]',
    }),
    {
      authMode: "cookie",
      cookieBundle: [{ name: "sessionid", value: "secret", domain: ".ark.test" }],
    },
  );
});

test("托管账号 Cookie 支持直接粘贴浏览器原始字符串", async () => {
  const { parseCookieInput, defaultCookieDomain } = await server.ssrLoadModule(
    "/src/lib/cookie-parser.ts",
  );
  const dialogModule = await server.ssrLoadModule("/src/components/users/managed-account-dialog.tsx");

  assert.equal(defaultCookieDomain("https://agent.oceanengine.com/"), ".oceanengine.com");
  assert.equal(defaultCookieDomain("https://ark.example.test/admin"), ".example.test");
  assert.equal(defaultCookieDomain("http://localhost:8000"), "localhost");
  assert.equal(defaultCookieDomain("not-a-url"), undefined);

  const raw = "sessionid_ss=abc123; bd_guard=eyJ0%3D%3D; sessionid_ss=def456; flagged";
  assert.deepEqual(parseCookieInput(raw, ".oceanengine.com"), [
    { name: "sessionid_ss", value: "def456", domain: ".oceanengine.com", path: "/" },
    { name: "bd_guard", value: "eyJ0%3D%3D", domain: ".oceanengine.com", path: "/" },
  ]);

  assert.throws(() => parseCookieInput("a=1; b=2", undefined), /domain/);
  assert.throws(() => parseCookieInput(";;=", ".oceanengine.com"), /未解析到任何 Cookie/);

  assert.deepEqual(
    dialogModule.buildManagedAccountPayload(
      {
        authMode: "cookie",
        username: "",
        password: "",
        cookieJson: "sid=tok; other=v",
      },
      ".oceanengine.com",
    ).cookieBundle,
    [
      { name: "sid", value: "tok", domain: ".oceanengine.com", path: "/" },
      { name: "other", value: "v", domain: ".oceanengine.com", path: "/" },
    ],
  );
});
