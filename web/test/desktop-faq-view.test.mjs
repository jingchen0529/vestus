import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (relative) => readFile(path.join(webRoot, relative), "utf8");

test("帮助内容与帮助分组是两个独立菜单", async () => {
  const sidebar = await read("src/components/layout/sidebar.tsx");
  assert.match(sidebar, /id: "faq",\s*\n\s*label: "帮助内容"/);
  assert.match(sidebar, /id: "faq-groups",\s*\n\s*label: "帮助分组"/);
  // 分组是结构配置，只给超管；内容列表所有管理员都能进（只读）。
  const gate = sidebar.match(/function isSuperAdminTab[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(gate.includes('"faq-groups"'), "faq-groups 应为超管专属");
  assert.ok(!gate.includes('"faq",'), "faq 不应对普通管理员隐藏");

  const header = await read("src/components/layout/header.tsx");
  assert.match(header, /faq: \{ title: "帮助内容"/);
  assert.match(header, /"faq-groups": \{ title: "帮助分组"/);

  const app = await read("src/App.tsx");
  assert.match(app, /"faq-groups",/);
  assert.match(app, /\{currentTab === "faq" && <FaqView isSuperAdmin=\{isSuperAdmin\} \/>\}/);
  assert.match(app, /\{currentTab === "faq-groups" && isSuperAdmin && <FaqGroupsView \/>\}/);
});

test("api-client 提供帮助内容四个端点", async () => {
  const apiClient = await read("src/lib/api-client.ts");
  assert.match(apiClient, /getDesktopFaq\(\): Promise<AdminDesktopFaqResponse>/);
  assert.match(apiClient, /getDesktopFaqTemplate\(\): Promise<DesktopFaqTemplateResponse>/);
  assert.match(apiClient, /saveDesktopFaq\(payload: DesktopFaqDocument\)/);
  assert.match(apiClient, /resetDesktopFaq\(\): Promise<AdminDesktopFaqResponse>/);
  assert.match(apiClient, /method: "DELETE"/);
});

test("列表化交互共用一份数据层：整篇校验 + 即时保存", async () => {
  const hook = await read("src/hooks/use-desktop-faq.ts");
  assert.match(hook, /validateFaqDocument\(faqDocumentToDrafts\(next\)\)/);
  assert.match(hook, /await api\.saveDesktopFaq\(next\)/);
  // 未自定义时把内置内容当草稿铺进列表，管理员看到的就是客户端当前内容。
  assert.match(hook, /const template = await api\.getDesktopFaqTemplate\(\);/);
  assert.match(hook, /setDoc\(\{ groups: faqGroupsFrom\(template\.faq\) \}\)/);
  assert.match(hook, /const reset = useCallback/);

  for (const view of [
    "src/components/desktop-faq/desktop-faq-view.tsx",
    "src/components/desktop-faq/desktop-faq-groups-view.tsx",
  ]) {
    const source = await read(view);
    assert.match(source, /useDesktopFaq\(\)/);
    assert.match(source, /DataCard/, `${view} 应使用统一的列表容器`);
  }
});

test("帮助内容页：列表 + 筛选 + 新增/编辑弹窗，不在页面上直接摊开表单", async () => {
  const view = await read("src/components/desktop-faq/desktop-faq-view.tsx");
  assert.match(view, /<TablePagination/);
  assert.match(view, /placeholder="搜索问题、答案或分组\.\.\."/);
  assert.match(view, /新增问答/);
  assert.match(view, /<FaqItemDialog/);
  assert.match(view, /<FaqImportDialog/);
  assert.match(view, /确认删除这条问答？/);
  // 普通管理员只读：新增/导入入口与操作列都收起。
  assert.match(view, /const editable = isSuperAdmin;/);
  assert.match(view, /\{editable && <TableHead className="w-\[280px\] text-right">操作<\/TableHead>\}/);
});

test("问答弹窗：分组可改、Markdown 编写 + 客户端预览、保存即下发", async () => {
  const dialog = await read("src/components/desktop-faq/faq-item-dialog.tsx");
  assert.match(dialog, /所属分组/);
  assert.match(dialog, /Markdown 编写/);
  assert.match(dialog, /客户端预览/);
  assert.match(dialog, /保存后立即下发到桌面端「常见问题」/);
  assert.match(dialog, /问题不能为空/);
  assert.match(dialog, /答案不能为空/);
  assert.match(dialog, /maxLength=\{FAQ_LIMITS\.maxQuestionLength\}/);
});

test("帮助分组页：分组列表 + 新增/编辑/删除/排序/恢复默认", async () => {
  const view = await read("src/components/desktop-faq/desktop-faq-groups-view.tsx");
  assert.match(view, /新增分组/);
  assert.match(view, /<FaqGroupDialog/);
  assert.match(view, /确认删除这个分组？/);
  assert.match(view, /恢复默认帮助内容？/);
  assert.match(view, /至少保留一个分组/);
  // 停用 / 排序都要能改。
  assert.match(view, /分组顺序已调整/);
  assert.match(view, /items: \[\]/);

  const dialog = await read("src/components/desktop-faq/faq-group-dialog.tsx");
  assert.match(dialog, /分组标题不能为空/);
  assert.match(dialog, /maxLength=\{FAQ_LIMITS\.maxTitleLength\}/);
});

test("校验规则与后端 schema 对齐，空分组允许作为草稿", async () => {
  const types = await read("src/types/desktop-faq.ts");
  assert.match(types, /maxGroups: 20/);
  assert.match(types, /maxItemsPerGroup: 50/);
  assert.match(types, /maxItemsTotal: 200/);
  assert.match(types, /maxQuestionLength: 200/);
  assert.match(types, /maxAnswerLength: 5000/);
  assert.match(types, /问题重复，请修改后再保存/);
  assert.match(types, /包含不允许的控制字符/);
  assert.match(types, /至少保留一个分组/);
  // 空分组是「先建栏目后补问答」的合法中间态，前端不再拦。
  assert.ok(!/每个分组至少保留一个问题/.test(types));

  const schema = await readFile(path.join(webRoot, "../app/schemas/desktop_faq.py"), "utf8");
  assert.ok(!/每个分组至少保留一个问题/.test(schema), "后端也应允许空分组");
  assert.match(schema, /MAX_ITEMS_PER_GROUP = 50/);
  assert.match(schema, /MAX_ITEMS_TOTAL = 200/);
});

test("每条改动走整篇 PUT，不需要额外「发布」步骤", async () => {
  const view = await read("src/components/desktop-faq/desktop-faq-view.tsx");
  // 每条操作都先深拷贝整篇文档，再交给 commit 校验保存。
  assert.match(view, /cloneFaqDocument\(doc\)/);
  assert.match(view, /await commit\(next, "问答已更新"\)/);
  assert.match(view, /await commit\(next, "问答已删除"\)/);
  assert.ok(!/保存并发布/.test(view), "列表化之后不应再要求手动发布");
});

test("弹窗底栏保持统一间距，不允许被覆盖成 0", async () => {
  // DialogFooter 自带 gap-2；在 className 里写 sm:gap-0 会把间距抹平，按钮直接贴在一起。
  const componentsDir = path.join(webRoot, "src/components");
  const entries = await readdir(componentsDir, { recursive: true });
  for (const entry of entries) {
    if (!entry.endsWith(".tsx")) continue;
    const source = await readFile(path.join(componentsDir, entry), "utf8");
    assert.ok(!/sm:gap-0/.test(source), `${entry} 把弹窗底栏间距覆盖成 0 了`);
  }
});
