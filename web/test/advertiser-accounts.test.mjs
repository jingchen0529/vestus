import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  appType: "custom", configFile: false, root: webRoot,
  cacheDir: path.join(webRoot, "node_modules/.vite/advertiser-accounts-test"),
  plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": path.join(webRoot, "src") } },
  server: { hmr: false, middlewareMode: true, ws: false },
});
after(() => server.close());
const envelope = (data, status = 200) => new Response(JSON.stringify({
  code: status === 200 ? 0 : status * 100, msg: status === 200 ? "ok" : "未找到访问记录",
  data, requestId: "synthetic-advertiser-test",
}), { status, headers: { "content-type": "application/json" } });
const filters = {
  userId: 21, platformId: 7, directMode: false, startAt: "2026-11-01", endAt: "2026-11-06",
  advertiserId: "009223372036854775809", managedAccountId: 31,
};

test("广告账户列表完整传递筛选，代理 false 和长广告 ID 不丢失，解包分页信封", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const expected = { items: [{ advertiserId: filters.advertiserId }], total: 1, page: 2, pageSize: 30, pages: 2 };
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url, "https://synthetic.invalid");
    assert.equal(parsed.pathname, "/api/admin/advertiser-accounts");
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
      page: "2", pageSize: "30", userId: "21", platformId: "7", directMode: "false",
      startAt: "2026-11-01", endAt: "2026-11-06", advertiserId: "009223372036854775809", managedAccountId: "31",
    });
    assert.equal(init.credentials, "include");
    return envelope(expected);
  };
  try { assert.deepEqual(await api.listAdvertiserAccounts({ ...filters, page: 2, pageSize: 30 }), expected); }
  finally { globalThis.fetch = originalFetch; }
});

test("选项只走 scope 接口，关联与来源按原始 ID 编码并保留筛选和 404", async () => {
  const { api, ApiError } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const paths = [];
  let denied = false;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url, "https://synthetic.invalid");
    paths.push(parsed.pathname);
    for (const [key, value] of Object.entries(filters)) assert.equal(parsed.searchParams.get(key), String(value));
    return envelope({ items: [], total: 0, page: 3, pageSize: 10, pages: 0 }, denied ? 404 : 200);
  };
  try {
    await api.getAdvertiserAccountOptions(filters);
    const query = { ...filters, page: 3, pageSize: 10 };
    await api.listAdvertiserAssociations(7, "00/a?&9", query);
    await api.listAdvertiserSources(7, "00/a?&9", query);
    assert.deepEqual(paths, [
      "/api/admin/advertiser-accounts/options",
      "/api/admin/advertiser-accounts/7/00%2Fa%3F%269/associations",
      "/api/admin/advertiser-accounts/7/00%2Fa%3F%269/sources",
    ]);
    denied = true;
    await assert.rejects(api.listAdvertiserSources(7, "missing", filters), error => error instanceof ApiError && error.status === 404);
  } finally { globalThis.fetch = originalFetch; }
});

test("CSV 全量拉取从第一页开始保留全筛选，不修改调用参数，空页立即停止", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const query = { ...filters, page: 9, pageSize: 10 };
  const seen = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url, "https://synthetic.invalid");
    for (const [key, value] of Object.entries(filters)) assert.equal(parsed.searchParams.get(key), String(value));
    const page = Number(parsed.searchParams.get("page"));
    seen.push(page);
    assert.equal(parsed.searchParams.get("pageSize"), "200");
    if (page > 2) throw new Error("空页后不得继续");
    return envelope({ items: page === 1 ? [{ advertiserId: filters.advertiserId }] : [], total: 999, pages: 5, page, pageSize: 200 });
  };
  try {
    assert.deepEqual(await api.fetchAllAdvertiserAccounts(query), [{ advertiserId: "009223372036854775809" }]);
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(query, { ...filters, page: 9, pageSize: 10 });
  } finally { globalThis.fetch = originalFetch; }
});

test("行级广告账户请求在列表与来源中保留会话 ID", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(new URL(url, "https://synthetic.invalid"));
    return envelope({ items: [], total: 0, page: 1, pageSize: 10, pages: 0 });
  };
  try {
    await api.listAdvertiserAccounts({ sessionId: 52 });
    await api.listAdvertiserSources(7, "12345", { sessionId: 52 });
    assert.equal(calls.length, 2);
    for (const url of calls) assert.equal(url.searchParams.get("sessionId"), "52");
  } finally { globalThis.fetch = originalFetch; }
});

test("会话每行在查看按钮旁提供广告账户列表", async () => {
  const { SessionTable } = await server.ssrLoadModule("/src/components/activity/session-table.tsx");
  const rows = [1, 2].map(id => ({
    id, username: `client${id}`, platformId: 7, pageCount: 1, visits: 1,
    clicks: 0, inputs: 0, submits: 0, scrolls: 0, dwellMs: 0, droppedPages: 0,
  }));
  const html = renderToStaticMarkup(createElement(SessionTable, {
    sessions: rows, onViewDetail() {}, onViewAdvertisers() {},
  }));
  assert.equal((html.match(/>广告账户列表</g) || []).length, 2);
  assert.equal((html.match(/>查看</g) || []).length, 2);
});

test("会话广告账户弹窗内容保持简洁并提供空列表提示", async () => {
  const { SessionAdvertiserTable } = await server.ssrLoadModule("/src/components/activity/session-advertiser-dialog.tsx");
  const render = items => renderToStaticMarkup(createElement(SessionAdvertiserTable, { items, onSelect() {} }));
  const html = render([account]);
  assert.match(html, /009223372036854775809/);
  assert.match(html, /最近访问/);
  assert.match(html, /查看来源/);
  assert.doesNotMatch(html, /客户端版本|设备码|来源 IP/);
  assert.match(render([]), /本次会话尚未记录到广告账户/);
});

const account = {
  advertiserId: "009223372036854775809", platformId: 7, platformName: "测试平台",
  managedAccountCount: 4, managedAccountNames: ["测试账号甲", "测试账号乙", "测试账号丙"],
  userCount: 5, usernames: ["测试用户甲"], sessionCount: 3, pageCount: 4, totalVisits: 8,
  unassociatedSessionCount: 1, firstSeenAt: "2026-11-01T00:00:00Z", lastSeenAt: null,
};

test("账户表显示字符串广告 ID、摘要数量和三种关联状态，并明确加载/空/错误状态", async () => {
  const { AdvertiserAccountsTable } = await server.ssrLoadModule("/src/components/activity/advertiser-accounts-view.tsx");
  const render = props => renderToStaticMarkup(createElement(AdvertiserAccountsTable, { onSelect() {}, ...props }));
  const html = render({ items: [account, { ...account, advertiserId: "0002", unassociatedSessionCount: 0 }, { ...account, advertiserId: "0003", managedAccountCount: 0, unassociatedSessionCount: 3 }] });
  for (const text of ["009223372036854775809", "复制广告 ID", "测试账号甲", "4 个账号", "5 位用户", "部分未关联", "未关联", ">关联<", "首次发现", "末次发现"]) assert.ok(html.includes(text), text);
  assert.match(render({ items: [], loading: true }), /加载广告账户/);
  assert.match(render({ items: [] }), /暂无广告账户访问记录/);
  assert.match(render({ items: [], error: "测试加载失败" }), /测试加载失败/);
});

test("来源直接展示完整 query 证据与会话入口，关联区分历史身份且不推断归属", async () => {
  const { AdvertiserSourcesTable, AdvertiserAssociationsTable } = await server.ssrLoadModule("/src/components/activity/advertiser-account-detail.tsx");
  const source = renderToStaticMarkup(createElement(AdvertiserSourcesTable, { onOpenSession() {}, items: [{
    pageId: 1201, sessionId: 52, userId: 21, username: "测试用户", managedAccountId: null,
    managedAccountName: null, remoteAccountId: null, identitySource: "unassociated",
    url: "https://synthetic.invalid/report", urlParams: "advid=009223372036854775809&test=1",
    firstSeenAt: null, lastSeenAt: null, visits: 2, clicks: 1, inputs: 0, submits: 0,
  }] }));
  for (const text of ["advid=009223372036854775809", "打开会话 #52", "未关联", "1201"]) assert.ok(source.includes(text), text);
  const associations = renderToStaticMarkup(createElement(AdvertiserAssociationsTable, { items: [{
    managedAccountId: 31, managedAccountName: "历史测试账号", remoteAccountId: "0009",
    remoteDisplayName: "历史测试身份", identitySource: "historical", credentialVersion: 2,
    userCount: 2, sessionCount: 3, firstSeenAt: null, lastSeenAt: null,
  }] }));
  assert.match(associations, /历史关联/);
  assert.match(associations, /历史测试身份/);
  assert.doesNotMatch(associations, /归属账号/);
});

test("广告账户 CSV 防公式注入，长 ID 以安全文本保存并保留北京时间与关联口径", async () => {
  const { advertiserCsvHeaders, advertiserCsvRows } = await server.ssrLoadModule("/src/components/activity/advertiser-accounts-view.tsx");
  const { buildCsvContent } = await server.ssrLoadModule("/src/lib/export-utils.ts");
  const csv = buildCsvContent(advertiserCsvHeaders, advertiserCsvRows([{ ...account,
    platformName: "=HYPERLINK(\"test\")", managedAccountNames: ["+test"], usernames: ["@test"],
  }]));
  for (const text of ["'009223372036854775809", "'=HYPERLINK", "'+test", "'@test", "2026-11-01 08:00:00", "部分未关联"]) assert.ok(csv.includes(text), text);
});

test("独立广告账户筛选提供字符串子串、scope 账号和页面区间口径", async () => {
  const { AdvertiserAccountFiltersBar, ADVERTISER_ACCESS_NOTICE } = await server.ssrLoadModule("/src/components/activity/advertiser-accounts-view.tsx");
  const { EMPTY_ADVERTISER_FILTERS, toAdvertiserAccountQuery } = await server.ssrLoadModule("/src/types/advertiser-account.ts");
  const values = { ...EMPTY_ADVERTISER_FILTERS, advertiserId: "00099", connection: "PROXY", managedAccountId: "31" };
  const html = renderToStaticMarkup(createElement(AdvertiserAccountFiltersBar, {
    filters: values, users: [{ id: 21, username: "测试用户" }], platforms: [{ id: 7, name: "测试平台" }],
    managedAccounts: [{ id: 31, name: "范围内测试账号" }], onChange() {},
  }));
  for (const text of ["广告 ID 子串", "巨量账号", "起始日期", "结束日期", "00099"]) assert.ok(html.includes(text), text);
  assert.equal(toAdvertiserAccountQuery(values).advertiserId, "00099");
  assert.equal(toAdvertiserAccountQuery(values).directMode, false);
  assert.match(ADVERTISER_ACCESS_NOTICE, /仅访问关联，不代表归属\/投放成功/);
  assert.match(ADVERTISER_ACCESS_NOTICE, /累计计数不是精确日内/);
});

test("筛选选项独立透传搜索及分页，默认有界且不把 search 发给账户列表", async () => {
  const { api } = await server.ssrLoadModule("/src/lib/api-client.ts");
  const originalFetch = globalThis.fetch;
  const calls = [];
  const expected = { platforms: [], managedAccounts: [], page: 2, pageSize: 100, managedAccountsHasMore: true, platformsHasMore: false };
  globalThis.fetch = async url => { calls.push(new URL(url, "https://synthetic.invalid")); return envelope(expected); };
  try {
    assert.deepEqual(await api.getAdvertiserAccountOptions({ ...filters, search: "测试 / 0031", page: 2, pageSize: 100 }), expected);
    assert.equal(calls[0].searchParams.get("search"), "测试 / 0031");
    assert.equal(calls[0].searchParams.get("page"), "2");
    assert.equal(calls[0].searchParams.get("pageSize"), "100");
    for (const [key, value] of Object.entries(filters)) assert.equal(calls[0].searchParams.get(key), String(value));
    await api.getAdvertiserAccountOptions();
    assert.equal(calls[1].searchParams.get("page"), "1");
    assert.equal(calls[1].searchParams.get("pageSize"), "100");
    await api.listAdvertiserAccounts({ search: "只搜索筛选项" });
    assert.equal(calls[2].searchParams.has("search"), false);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("筛选项分页拼接按各自 ID 去重，新搜索第一页清空旧页且独立保留更多标记", async () => {
  const { mergeAdvertiserOptionPage } = await server.ssrLoadModule("/src/components/activity/advertiser-accounts-view.tsx");
  const first = { managedAccounts: [{ id: 31, name: "测试账号" }], platforms: [{ id: 7, name: "测试平台" }], page: 1, pageSize: 100, managedAccountsHasMore: true, platformsHasMore: true };
  const second = { managedAccounts: [{ id: 31, name: "更新名称" }, { id: 32, name: "次页账号" }], platforms: [{ id: 7, name: "测试平台" }], page: 2, pageSize: 100, managedAccountsHasMore: false, platformsHasMore: true };
  const result = mergeAdvertiserOptionPage(first, second);
  assert.deepEqual(result.managedAccounts, [{ id: 31, name: "更新名称" }, { id: 32, name: "次页账号" }]);
  assert.deepEqual(result.platforms, [{ id: 7, name: "测试平台" }]);
  assert.equal(result.managedAccountsHasMore, false);
  assert.equal(result.platformsHasMore, true);
  assert.deepEqual(first.managedAccounts, [{ id: 31, name: "测试账号" }]);
  assert.deepEqual(mergeAdvertiserOptionPage(result, { ...first, managedAccounts: [], platforms: [] }).managedAccounts, []);
});

test("筛选项搜索说明仅搜索平台/巨量账号，任一分类有后页才显示加载更多", async () => {
  const { AdvertiserOptionsSearch } = await server.ssrLoadModule("/src/components/activity/advertiser-accounts-view.tsx");
  const render = options => renderToStaticMarkup(createElement(AdvertiserOptionsSearch, { search: "测试", options, onSearch() {}, onLoadMore() {} }));
  const options = { platformsHasMore: false, managedAccountsHasMore: false };
  assert.match(render(options), /筛选项搜索/);
  assert.match(render(options), /平台\/巨量账号名称或 ID/);
  assert.doesNotMatch(render(options), /加载更多筛选项/);
  assert.match(render({ ...options, platformsHasMore: true }), /加载更多筛选项/);
  assert.match(render({ ...options, managedAccountsHasMore: true }), /加载更多筛选项/);
});
