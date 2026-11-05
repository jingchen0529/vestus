import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const faqView = await readFile(
  path.join(desktopRoot, "src/components/faq/FaqView.tsx"),
  "utf8",
);
const app = await readFile(path.join(desktopRoot, "src/App.tsx"), "utf8");
const sidebar = await readFile(
  path.join(desktopRoot, "src/components/layout/Sidebar.tsx"),
  "utf8",
);
const bridge = await readFile(
  path.join(desktopRoot, "src/services/tauriBridge.ts"),
  "utf8",
);
const baseline = JSON.parse(
  await readFile(path.join(desktopRoot, "src/assets/desktopFaqBaseline.json"), "utf8"),
);

test("常见问题注册为独立侧边栏菜单并接入视图切换", () => {
  assert.match(sidebar, /"faq"/);
  assert.match(sidebar, /label: "常见问题", icon: CircleHelp/);
  assert.match(app, /import \{ FaqView \} from "@\/components\/faq\/FaqView"/);
  assert.match(app, /activeTab === "faq" \? \(\s*<FaqView \/>/s);
});

test("tauriBridge 走 desktop_faq 命令拉取内容", () => {
  assert.match(bridge, /DesktopFaqPayload/);
  assert.match(bridge, /async fetchDesktopFaq\(\): Promise<DesktopFaqPayload>/);
  assert.match(bridge, /invokeDesktop<DesktopFaqPayload>\("desktop_faq"\)/);
});

test("视图实现三级降级：服务端 → 本地缓存 → 内置基线", () => {
  assert.match(faqView, /const CACHE_KEY = "vestus-desktop-faq-cache"/);
  assert.match(faqView, /import baseline from "@\/assets\/desktopFaqBaseline\.json"/);
  // 服务端内容写入缓存。
  assert.match(faqView, /writeCache\(next\)/);
  // IPC 返回的是 { groups } 文档，不是数组（2026-11-05 修正）。
  assert.match(faqView, /payload\.groups\.length > 0/);
  // 未配置回内置基线并清掉过期缓存。
  assert.match(faqView, /next = baseline\.groups as FaqGroups;\s*\n\s*clearCache\(\);/);
  // 底部固定客服兜底文案（不后台配置）。
  assert.match(faqView, /以上内容未覆盖的问题，请联系管理员或渠道客服/);
});

test("页面不闪不转圈：缓存优先首帧 + 静默刷新", () => {
  // 首帧直接用缓存/内置基线渲染，不等接口。
  assert.match(faqView, /useState<FaqGroups>\(\(\) => readCache\(\) \?\? \(baseline\.groups as FaqGroups\)\)/);
  // 内容没变化时不触碰状态，避免无意义重渲染。
  assert.match(
    faqView,
    /JSON\.stringify\(current\) === JSON\.stringify\(next\) \? current : next/,
  );
  // 拉取失败静默保留当前展示内容，不弹错不清空。
  assert.match(faqView, /静默保留当前展示的内容，不打扰用户/);
  // 没有整页加载态：loading 只驱动刷新按钮的小图标。
  assert.doesNotMatch(faqView, /loading && groups\.length === 0/);
});

test("内置内容默认全部分组展开", () => {
  assert.match(faqView, /new Set\(groups\.map\(\(_, index\) => index\)\)/);
  assert.match(faqView, /setOpenKeys\(new Set\(next\.map\(\(_, index\) => index\)\)\)/);
  // 折叠仍可点击切换。
  assert.match(faqView, /const toggleGroup = \(index: number\)/);
});

test("内置基线结构与后端模板一致且非空", () => {
  assert.ok(Array.isArray(baseline.groups) && baseline.groups.length >= 4);
  for (const group of baseline.groups) {
    assert.equal(typeof group.title, "string");
    assert.ok(group.title.length > 0, "分组标题不能为空");
    assert.ok(Array.isArray(group.items) && group.items.length > 0, "每组至少一条问答");
    for (const item of group.items) {
      assert.equal(typeof item.question, "string");
      assert.ok(item.question.length > 0 && item.question.length <= 200);
      assert.equal(typeof item.answer, "string");
      assert.ok(item.answer.length > 0 && item.answer.length <= 5000);
    }
  }
  // 与后台模板 `app/services/desktop_faq_template.py` 同源：分组数一致。
  assert.equal(baseline.groups.length, 4);
});
