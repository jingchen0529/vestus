# 桌面端常见问题（Q&A）后台配置设计

> 状态：已实现（2026-11-05），实现记录见 `issues/01`–`issues/06`；管理端界面已按 v4 重构
>
> 修订历史：
> v3 只保留两张表：分组表 + 问答条目表
> v4（2026-11-05，同日）管理端从「整页编辑器」改为「帮助分组 + 帮助内容」两个列表页 + 弹窗，
> 并推翻下文两条原始结论，见 §0.1
> v5（2026-11-05，同日）客户端渲染升级：答案支持受限 Markdown（加粗/列表/换行），问答显示连续题号，见 §0.2
> v5.1（2026-11-05）修正三层形状不一致导致的崩溃，见 §0.3
>
> 背景：客户使用文档（`docs/desktop-ark-auto-login-faq.md`）目前以 Markdown 交付给产品。
> 产品决定把它内置进桌面客户端，且要求后续内容由后台自由配置，不必随客户端发版更新。

## 0. 结论先行

| 决策点 | 结论 |
| --- | --- |
| 存储 | 两张表：`desktop_faq_group`（大分组）/ `desktop_faq_item`（问答条目） |
| 保存模型 | ~~管理端整文档编辑 + 保存时单事务整体替换（保留草稿-发布语义）~~ **v4 起：每个弹窗操作即整篇 PUT，单事务替换，无「发布」步骤** |
| 内容格式 | ~~结构化 Q&A，纯文本+换行，不做 markdown/富文本~~ **v4：答案按 Markdown 编写（空行分段、`- ` 列表）；v5：客户端按受限 Markdown 渲染（`**加粗**`、`- `/`1. ` 列表、换行），其余符号原样显示** |
| 题号 | v5 起客户端在每条问答前显示连续编号 Q1…Qn，编号按当前展示顺序算，不写进数据 |
| 空分组 | v4 起允许：先建栏目再补问答；客户端下发时会过滤掉没有启用条目的分组 |
| 联系方式 | **不做后台配置**，客户端内置固定文案（如「未覆盖的问题请联系管理员或渠道客服」） |
| 编辑权限 | 超管可编辑（`super_admin_auth`），普通管理员只读（`admin_auth`） |
| 管理端入口 | v4 起拆为两个菜单：「帮助内容」（问答列表，所有管理员可见、普管只读）与「帮助分组」（栏目结构，仅超管） |
| 桌面端入口 | 独立侧边栏菜单「常见问题」（`desktop/src/components/layout/Sidebar.tsx` 新增项） |
| 下发方式 | 独立接口 `GET /api/user/desktop-faq`，不进 desktop-config lease 看门狗 |
| 兜底链 | 服务端自定义内容 → 客户端本地缓存 → 客户端内置基线 |

### 0.1 v4 为什么要推翻这两条

- **草稿-发布语义**：v3 把所有分组和问答摊在一页，靠一个「保存并发布」统一提交，编辑时点太多。
  v4 改成列表 + 弹窗后，单条操作必须有明确结果，于是每次提交都写整篇文档（接口未变），
  去掉发布这一步；风险是多人同时编辑会互相覆盖（当前只有一个超管在维护，可接受）。
- **不做 Markdown**：v3 的判断基于「客户端只做纯文本渲染」，这点没变；变的只是**编写侧**。
  答案正文按 Markdown 写能一眼看出段落和列表，整篇还能一次导入十几条。为避免客户端露出符号，
  管理端对 `**加粗**`、表格、链接只给黄色提示、不拦保存。

### 0.2 v5：客户端渲染升级

- **题号**：客户端每条问题前显示 `Q1…Qn`，全页连续编号（跨分组累加），与客户文档 Q1–Q14 的口径一致。
  编号由展示顺序算出，不落库——增删、排序、停用后编号自动跟对，也不会因为管理员手写编号而错位。
- **受限 Markdown**：只解析「空行分段 / `- `·`* `·`+ ` 无序列表 / `1. `·`1) ` 有序列表 / `**加粗**` / 段内换行」，
  解析成结构化节点后交给 React 渲染，不拼 HTML、不用 `dangerouslySetInnerHTML`，后台写什么都执行不了。
  代码块、引用、表格、链接、图片、标题不解析，原样显示——宁可朴素，也不要半吊子渲染撑破布局。
- **两端同源**：`desktop/src/lib/mini-markdown.ts` 与 `web/src/lib/mini-markdown.ts` 是逐字副本，
  管理端「客户端预览」与客户端用同一套解析规则；`web/test/mini-markdown.test.mjs` 用同一批用例
  比对两份实现，任一边改了行为测试即挂。
- **兼容**：老客户端仍是纯文本渲染，内容侧暂时不写 `**`（保持“纯文本也读得通”），
  等升级覆盖后再按文档原样回填 Q6 的加粗、Q10 的列表，Q9 也能恢复成「按 Q8 处理」。

> 改动落地位置：`web/src/components/desktop-faq/`（两个列表页 + 三个弹窗）、
> `web/src/hooks/use-desktop-faq.ts`（整篇校验与提交）、
> `web/src/types/desktop-faq-markdown.ts`（Markdown 解析/序列化）、
> `app/schemas/desktop_faq.py`（放开空分组限制）。

### 0.3 v5.1：`faq` 的三层形状（踩过的坑）

同一份内容在链路上有三种形状，写错任一层就白屏或静默回退：

| 层 | 形状 | 出处 |
| --- | --- | --- |
| HTTP（管理端 GET/PUT、客户端 GET） | `data.faq` = **分组数组** | `services.desktop_faq._assemble()` 返回 list |
| HTTP（`/api/admin/desktop-faq/template`） | `data.faq` = `{ groups: [...] }` | 直接返回常量模板文档 |
| 桌面端 IPC（`desktop_faq` 命令） | `{ groups: [...] }` | Rust `DesktopFaqView` 序列化 |

- 管理端原先把 `data.faq` 直接当文档塞进 state，`doc.groups` 是 `undefined`，列表页 `groups.map` 抛
  `Cannot read properties of undefined (reading 'map')`（2026-11-05 白屏）。现在统一走
  `faqGroupsFrom()` 归一化，并用 `web/test/faq-payload-shape.test.mjs` 锁住这个函数的四种输入。
- 桌面端 Rust 的 `DesktopFaqWire` 原按 `{ faq: { groups } }` 反序列化，与 HTTP 的数组不符，
  解析失败被 catch 静默吞掉 → 客户端永远显示内置基线。现已改为 `Option<Vec<DesktopFaqGroupWire>>`，
  TS 侧 `DesktopFaqPayload` 同步改成 `{ groups } | null`（IPC 形状）。
- 结论：**HTTP 层是数组，IPC 层是对象**。新增消费方时先看这张表，别按直觉写 `.groups`。

## 1. 意图

管理员在后台「帮助内容」菜单维护一份面向桌面端客户的 Q&A（大分组 + 问答条目），
桌面客户端侧边栏「常见问题」菜单展示。修改即时生效，不需要发布新版客户端；
后台未配置时，客户端展示随版本内置的基线内容。

数据示例（对应交付文档的结构）：

- 分组 = 《三、多个方舟账号》这样的章节标题；
- 条目 = 该章下的 `Q10：我可以看到多个「方舟」入口卡片，是正常的吗？` +
  答案正文，一个分组挂多条。

## 2. 目标

- 超级管理员可增删改、排序分组和问答条目，整体保存或恢复默认；
- 分组和条目支持单独停用/启用（临时下架一条不改内容）；
- 普通管理员可查看当前内容（便于渠道客服按客户所见答疑），不可修改；
- 内容修改即时到达已登录的桌面客户端，无需重新登录或点「重新同步配置」；
- 弱网/离线时客户端仍能展示内容（本地缓存与内置基线兜底）；
- 所有保存/恢复动作进审计日志。

## 3. 非目标

- ~~不做 markdown / 富文本，答案为纯文本（保留换行）~~ —— **v4 已变更**：编写侧用 Markdown，客户端仍按纯文本渲染（见 §0.1）；
- 不做联系方式卡片的后台配置（客户端固定文案，见 §0）；
- 不做全局一键停用（临时下线全部内容 = 清空两表走「恢复默认」）；
- 不做按用户、按渠道差异化的多份内容（全局一份；独立建表后未来可平滑加维度）；
- 不做浏览量统计、点赞/反馈；
- 不做历史版本回滚（整体覆盖 + 恢复默认已够用）；
- 不把 FAQ 纳入 desktop-config lease 看门狗（理由见 §6.3）。

## 4. 数据模型

两张表，风格对齐现有模型（`IdType`/`DateTime6`/`TABLE_ARGS`、`sort_order` 带索引、
**不建 SQL 外键**——仓库全部模型如此，级联删除在应用层同一事务完成）；
启停状态沿用 `platform` 表的 `status` 惯例（`active`/`disabled`）：

```python
# app/db/models/desktop_faq.py

class DesktopFaqGroup(Base):
    """大分组，例如《三、多个方舟账号》。"""
    __tablename__ = "desktop_faq_group"

    id          # IdType pk
    title       # String(100)
    sort_order  # Integer, index
    status      # String(16), default "active", index  # active / disabled
    created_at / updated_at  # DateTime6


class DesktopFaqItem(Base):
    """一条问答，例如 Q10 的问题 + 答案正文。"""
    __tablename__ = "desktop_faq_item"

    id
    group_id    # Integer, index；无外键约束，删组时同事务删条目
    question    # String(255)
    answer      # Text
    sort_order  # Integer, index
    status      # String(16), default "active", index
    created_at / updated_at  # DateTime6
```

要点：

- 两表一行数据都不存在 = 后台未自定义，客户端走内置基线（「恢复默认」即回到该状态）；
- `sort_order` 由保存顺序生成（0..n），数组顺序即展示顺序；
- 桌面端组装时只取 `status="active"` 的组和条目；管理端读取返回全部（含停用项及状态）；
- 客户端缓存不做版本号：拉取时机本身保证了新鲜度（见 §6.3），成功即整体覆盖本地缓存。

**为什么不需要 meta 单例行**（评审结论）：原设计 meta 承担的三件事都有更简单的归宿——
联系方式改为客户端固定文案，不做配置；全局停用等价于清空两表（恢复默认）；
版本号在「打开菜单即拉取」的模型里没有消费者，`created_at`/`updated_at`
列按仓库惯例保留，管理端「最近保存时间」直接取条目最大 `updated_at` 展示。

**保存为什么是整体替换而不是行级 CRUD**：整文档 PUT 在服务端一个事务内
`DELETE` 旧组/条目 → 按提交顺序重插，要么全生效要么全不变。行 id 不对外引用，
替换后 id 变化无影响。

> **v4 补充**：这条只解释「为什么没有行级接口」，不再意味着「草稿→发布」——
> 每次弹窗保存都会立即整篇替换并下发。后端契约因此完全没变，变的是管理端的操作粒度。

## 5. 校验规则（`app/schemas/desktop_faq.py`）

风格对齐 `app/schemas/settings.py`（camelCase alias、`field_validator`、中文错误信息）。

| 字段 | 规则 |
| --- | --- |
| `groups[].status` | 枚举 `active`/`disabled`，默认 `active` |
| `groups` | 1..20 个（不允许整份为空；下线全部内容走「恢复默认」） |
| `groups[].title` | 1..50 字符，strip |
| `groups[].items` | ~~1..50 条/组~~ **v4 起 0..50 条/组**（允许空分组，客户端下发时过滤），全文档总条目 ≤ 200 |
| `items[].question` | 1..200 字符，strip；同组内拒绝重复（400「同一分组内存在重复的问题」） |
| `items[].answer` | 1..5000 字符，strip 首尾（保留内部换行） |
| 控制字符 | 拒绝除 `\n` 外的控制字符（对齐品牌标题的 `isprintable` 思路） |
| 提交体体积 | ≤ 512 KB 硬上限 |

超限返回 400，错误信息带定位（如「第 3 组『日常使用』第 12 条答案超长」）。

## 6. 接口

### 6.1 管理端

```
GET    /api/admin/desktop-faq   # admin_auth：普通管理员可读
PUT    /api/admin/desktop-faq   # super_admin_auth：整文档保存（事务替换）
DELETE /api/admin/desktop-faq   # super_admin_auth：恢复默认（清空两表）
```

- `GET` → `{"faq": <文档|null>, "updatedAt": <最近保存时间|null>}`；`null` = 未自定义。
  文档含全部组/条目（含停用项）及状态；
- `PUT` 请求体只含内容字段（`groups`，组与条目带各自 `status`）；
  响应返回保存后的完整文档；
- `PUT` 事务边界：删全部组与条目 → 按提交顺序重插（含状态），任一步失败整体回滚；
- `DELETE` 同一事务清空两表，响应 `{"faq": null}`；
- 响应一律 `Cache-Control: no-store`；
- 审计：`DESKTOP_FAQ_UPDATED` / `DESKTOP_FAQ_RESET`，detail 落摘要
  （`更新客户端帮助内容：X 组 / Y 条`），不落全文；
- tag 归入 `desktop-config`。

### 6.2 桌面端

```
GET /api/user/desktop-faq   # user_auth
```

- 响应 `{"faq": <文档|null>}` + `Cache-Control: no-store`；
- 组装：无任何行、或无启用的组/条目 → `{"faq": null}`；否则只含 `active`
  的组和条目（按 `sort_order`）；
- 用户不存在沿用 404「用户不存在」；
- 审计 `DESKTOP_FAQ_READ`（`record_standalone`，读不因日志失败回滚）；
- 沿用 `EnvelopeRoute` 信封，客户端走与 `desktop-config` 相同的认证与解包链路。

### 6.3 文档 JSON 形状与下发时机

```json
{
  "groups": [
    {
      "id": 3,
      "title": "多个方舟账号",
      "status": "active",
      "items": [
        { "id": 12, "question": "我可以看到多个「方舟」入口卡片，是正常的吗？",
          "answer": "正常。如果管理员为您的账号绑定了多个方舟账号…",
          "status": "active" }
      ]
    }
  ]
}
```

**为什么不进 lease 看门狗**：`/api/user/desktop-config/lease` 的语义是「哈希所有会
改变桌面路由的全局资源」。FAQ 不改变任何路由行为；若计入 lease，管理员改一条帮助
文案会让全部在线客户端触发 `desktop_config_changed` → 静默重同步 + 弹出「管理员已
更新全局配置」toast——用配置变更提示打扰全部用户只为推一份文档，得不偿失。

**下发时机（客户端侧，见 §8）**：打开「常见问题」菜单时拉取。用户看到文档的时刻
恰好就是拉取时刻，实时性足够，缓存也永远被最新一次成功拉取覆盖，无需版本号参与
失效判断；只新增一个只读接口。

## 7. 管理端 UI（web）

独立导航菜单「帮助内容」，不并入系统配置页：

- 路由与导航：`web/src/App.tsx` 新路由；`web/src/components/layout/sidebar.tsx`
  新增菜单项，所有管理员可见（普通管理员进入只读视图）；
- 组件目录：`web/src/components/desktop-faq/desktop-faq-view.tsx`；
- 页面结构：
  > **v4 已重做，以下为 v3 的整页编辑器描述，仅作历史记录。**
  > 现行界面：两个列表页 —— 「帮助内容」（问答列表：搜索/分组筛选/状态筛选/分页 +
  > 新增·编辑弹窗、批量导入、导出）+「帮助分组」（栏目列表：排序/新增/编辑/删除/恢复默认）。

  - 顶部：最近保存时间 + 「保存」「恢复默认」；
  - 分组列表：每组 = 标题输入框 + 组停用开关 + 条目列表（每条：问题单行输入、
    答案多行 textarea + 字数计数、条目停用开关）、上移/下移/删除；
    组可上移/下移/删除；「添加分组」「添加问题」；
  - 右侧（宽屏）或折叠（窄屏）实时预览：按客户端折叠列表样式渲染；
  - 未自定义时展示空态：「当前客户端使用内置内容」+「用内置内容初始化编辑器」按钮；
- 校验：前端按 §5 同规则先行校验并定位到字段，400 错误信息 toast 展示；
- 内置模板：后端常量 `DEFAULT_DESKTOP_FAQ_TEMPLATE`
  （`docs/desktop-ark-auto-login-faq.md` 的结构化版本），供「初始化编辑器」预填。
  该常量与桌面端内置基线同源，更新文档时两处需同步（在常量处注释标明）。

## 8. 桌面端（本期只定契约，实现另拆票）

- 入口：侧边栏独立菜单「常见问题」（`desktop/src/components/layout/Sidebar.tsx`
  的 items 新增 `{ id: "faq", label: "常见问题" }`），独立视图 `FaqView`；
- 拉取时机：进入该视图时必拉；登录成功后、desktop-config 同步成功后顺带拉取；
- 三级降级：接口成功 → 展示并整体覆盖本地缓存（localStorage
  `vestus-desktop-faq-cache`）；接口失败 → 上次缓存；无缓存 → 内置基线
  （随客户端版本打包的同一份结构化 JSON）；
- 展示：分组折叠列表，问题展开显示答案，纯文本保留换行；底部固定一行
  「以上内容未覆盖的问题，请联系管理员或渠道客服」内置文案（不后台配置）；
- 内容为公开信息，无脱敏要求，普通 localStorage 即可；
- 版本错位：自定义内容可能描述新版客户端才有的界面，内置基线统一带
  「界面以实际版本为准」提示。

## 9. 测试

后端（pytest，隔离 fixture 模式与现有测试一致）：

- 模型/迁移：两表创建、组删除时条目同事务清理、sort_order 生成；
- schema：各字段超限、空组/空条目、同组重复问题、控制字符、总条目超 200、
  非法 status 枚举；
- 权限：普通管理员 `GET` 200 / `PUT`、`DELETE` 403；桌面用户访问 admin 接口 403；
- `PUT` 事务替换：重复保存不残留旧行；中途失败不残留半份内容；
- 组/条目 `status=disabled`：管理端返回、桌面端不返回；
- `DELETE` 后管理端与用户端 `GET` 均返回 null；
- 用户端组装：未配置/全停用返回 `{"faq": null}`，配置后只含启用项；审计行写入；
- 现有 desktop-config 相关测试无回归。

管理端（web vitest）：表单校验、排序与增删、停用开关、只读态（普通管理员）、
保存/恢复默认调用与回显、空态与「初始化编辑器」（v4 后对应两个列表页与弹窗的回归测试，
见 `web/test/desktop-faq-view.test.mjs`）。

## 10. 验收

- 超管在后台改一条答案并保存后，客户打开桌面端「常见问题」立即看到新内容，
  全程无需重新登录或重新同步；
- 单独停用某条目后，客户端不再展示该条，其余不变；重新启用即恢复；
- 恢复默认（清空两表）后，客户端回退内置基线；
- 拔网线打开「常见问题」，展示最近一次缓存内容；
- 普通管理员能看不能改；所有写操作在审计日志可查到操作者与摘要；
- `python3 -m pytest -q tests`、`cd web && npm test && npm run build` 通过。

## 11. 拆票建议

| 票 | 内容 | 依赖 |
| --- | --- | --- |
| 01 | 两表模型 + alembic 迁移 | - |
| 02 | schema 校验 + 管理端三个接口 + 审计 + 后端测试 | 01 |
| 03 | `GET /api/user/desktop-faq` 组装逻辑 + 内置模板常量 + 后端测试 | 02 |
| 04 | 管理端「帮助内容」独立菜单页（编辑器、预览、停用开关、只读态） | 02 |
| 05 | 桌面端「常见问题」独立菜单：入口、拉取、三级降级、内置基线 JSON | 03 |
| 06 | 把 `docs/desktop-ark-auto-login-faq.md` 转为结构化 JSON，填充模板与基线 | 03, 05 |
