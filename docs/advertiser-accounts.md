# 广告账户访问索引

## 统计口径与身份边界

- 本功能回答「哪些用户/托管账号访问过某个广告账户」，不是广告账户所有权、授权关系或平台账户清单。一个页面出现 `advid`，只能作为访问证据。
- 列表按平台与广告账户 ID 聚合；页面数是已索引的页面记录数，访问次数取原页面累计 `visits`。用户数、会话数、托管账号数按对应 ID 去重。权限范围及筛选先作用于来源页面，再聚合，不能用全局统计泄露范围外记录。
- 日期筛选按北京时间自然日与页面首末记录区间相交，不是页面内报表筛选日期，也不表示准确的日内操作次数。主表名称摘要批量查询、最多展示三项；详情分页保留各身份快照关系。
- 平台和托管账号筛选项支持名称／ID 搜索、每页 100 项（最多 200）、手动加载更多；选项查询遵守同一权限范围，不一次拉取所有账号。
- 识别复用 `app.services.advertiser_identity.extract_advertiser`，只支持 HTTP/HTTPS 的 `localads.chengzijianzhan.cn`、`oceanengine.com` 及其真正的子域（如 `business.oceanengine.com`）。相似后缀、其他站点、含 URL 用户名/密码的地址不支持；不支持任意 `chengzijianzhan.cn` 子域。
- 只读取已记录、已清洗的 `url` 和单独保存的 `url_params`。参数名必须精确为 `advid`；ID 是 1–64 位十进制数字，首位 1–9，始终作为字符串处理。同一 ID 重复出现可匹配；多个不同合法 ID 为 `ambiguous`；空值、前导零、非数字或过长值为 `invalid`；缺少参数为 `missing`。不猜测、不请求上游、不读取凭据。
- `browser_page_advertiser.page_id` 是主键，一页最多一个广告账户；`advertiser_id` 有查询索引。外键仅保证删除 `browser_page_visit` 时级联删除该页索引。原有会话与页面之间没有数据库级联约束，不能据此承诺删除会话会自动删除页面。

新启动票据被消费时保存托管账号名称、远端身份和时间快照，活动会话记录对应票据身份。`identity_snapshot_at` 是快照时间，`identity_verified_at` 是身份验证时间，两者不等同。

迁移前的活动会话和票据，其新增身份字段保持 `NULL`；回填也不拿「当前托管账号身份」冒充历史身份。历史已关联记录保留历史/未知标识，未关联托管账号的访问保持未关联，不自动分配账号。

## 0018 迁移

`migrations/versions/0018_advertiser_access.py` 从 `0017` 升级，只添加以下结构，不更新已有记录：

- `browser_session`：可空的 `bootstrap_session_id`（索引）、`remote_account_id`、`remote_display_name`、`credential_version`、`identity_snapshot_at`、`identity_verified_at`。
- `managed_browser_session`：可空的 `remote_account_id`、`remote_display_name`、`managed_account_name`、`identity_snapshot_at`、`identity_verified_at`。
- `browser_page_advertiser`：页面主键/外键和广告账户 ID，MySQL 使用 InnoDB；ID 类型保持 MySQL BIGINT、SQLite INTEGER，时间字段保持 MySQL DATETIME(6)。

降级到 `0017` 仅撤销本次新增表、列和索引，不重建原页面或清零累计计数；新增索引与身份快照会丢失。回滚前应先停用依赖新结构的后端/客户端，并按运维流程备份。不得移动既有发布标签。

原 V2 活动批次的哈希兼容保持不变：没有 `bootstrapSessionId` 时，在哈希输入中省略新增字段，不能把新增的 `null` 纳入原批次哈希。迁移及回填不修改批次回执、页面 URL 哈希或原始计数，不重放活动上报。

## 回填脚本

入口是 `python -m scripts.backfill_advertiser_accounts`。默认只预览，只有显式 `--apply` 才写索引。使用 `Database(url, initialize=False)`，不建表、不 bootstrap 管理员、不迁移、不更新会话身份或页面数据。

| 参数 | 行为 |
| --- | --- |
| `--database-url` | 显式指定目标；省略时按既有脚本惯例读取应用配置的 `VESTUS_DATABASE_URL`（正常环境可能加载项目 `.env`）。不要把含密码的命令粘贴到日志/工单，脚本也不会回显连接 URL。 |
| `--apply` | 写入缺失索引；默认不写。 |
| `--batch-size` | 每批页面数，默认 500，允许 1–1000。 |
| `--max-batches` | 本次最多处理的批数，正整数；省略则处理到当前可见尾部。 |
| `--after-id` | 从 `page.id > 此值` 开始，默认 0，只允许非负整数。不是偏移量。 |

每批按页面 ID 升序 keyset 扫描并单独提交事务；不会对整表使用 OFFSET，也不会把所有页面载入内存。应用时复用线上 `ensure_index`，先检查已有索引，已有项不会重复写、覆盖或虚增 `indexed`。MySQL 应用批次锁定正在处理的页面，以协调同时更新页面的线上写入；数据库唯一键仍是最终幂等保障。预览不取得写锁。

标准输出是一个 JSON 对象，不含地址、查询参数、数据库连接串或凭据。驱动失败也不输出原始异常/SQL。退出码：0 为本轮正常结束（可能因批数上限暂停），1 为数据库/回填失败，2 为参数错误。

| 统计字段 | 含义 |
| --- | --- |
| `dryRun` | 是否预览。 |
| `scanned` | 已完成批次中扫描的页面数，不是访问次数。 |
| `matched` | 可唯一识别广告账户的页面数，包含已有索引页面。 |
| `indexed` | 本轮应用新建的页面索引数；预览固定为 0。 |
| `wouldIndex` | 预览预计新增的索引数；应用固定为 0。 |
| `existing` | 扫描时已有索引的页面数。 |
| `skipped` | 已有索引或无法识别而未新建的页面数，每页最多计一次；包含 `existing`。 |
| `unsupported` / `missing` / `invalid` / `ambiguous` | 提取结果的各类页面数；与 `matched` 合计为 `scanned`。 |
| `lastPageId` | 最后一个成功完成批次的页面 ID；未扫描时保留 `--after-id`。应用时只在提交成功后推进。 |
| `batches` | 成功完成的非空批次数。 |
| `completed` | 最后检查时没有更大的可见页面 ID；达到批数上限且还有页面时为 false。不是永久完成标志或一致性快照。 |
| `error` | 仅失败时出现的固定错误码，如 `backfill_failed`、`database_unavailable`。 |

应用失败时整批回滚，之前提交的批次保留；失败输出中的计数和断点不包含已回滚批次。修复原因后，可用最后一次**应用**输出的 `lastPageId` 续跑。不能把纯预览的断点直接当作已回填断点，否则会跳过预览过、实际未写入的页面。中断未拿到输出时，从上一次可靠断点或 0 重跑即可。

并发新写入、延迟提交和清理会影响每轮可见数据。`completed=true` 不证明所有未来写入已被扫描；可以从 0 重跑核对缺漏。原始历史里没有保留下来的参数无法恢复。

## 升级顺序（操作说明，不代表已执行）

1. 备份并确认目标数据库，在批准的维护流程中先执行 `0017 → 0018` 迁移。
2. 升级**所有**后端实例，使新活动写入索引并支持身份票据/新字段；混跑旧写入器可能继续制造未索引页面。
3. 在确认的目标上先预览、核对统计，再分批应用回填；保存应用 JSON 中的断点。必要时从 0 幂等重跑检查历史缺口。
4. 最后升级新桌面端。旧端上报仍兼容，但没有启动票据的历史身份不能凭当前状态补全。

以下只是已准备好目标数据库后的命令形式，不是线上执行授权；操作前必须独立确认配置指向正确环境：

```sh
# 预览一批，不写入
python -m scripts.backfill_advertiser_accounts --batch-size 500 --max-batches 1

# 经确认后应用；按本次输出的 lastPageId 继续
python -m scripts.backfill_advertiser_accounts --apply --batch-size 500 --max-batches 20 --after-id 0
```

## 本地验证及限制

- `tests/api/test_advertiser_migration.py` 在临时 SQLite 上手工启用 `PRAGMA foreign_keys=ON`，运行真实迁移链至 `0017`，验证 `0018` 升级与降级、历史数据/索引/约束保留、新增字段可空、本次涉及表与模型元数据一致及页面删除级联。
- `tests/scripts/test_backfill_advertiser_accounts.py` 通过隔离子进程、禁用 dotenv、显式临时 SQLite 验证默认无写入/无 bootstrap、重复应用、线上已有索引兼容、非连续 ID 断点、参数边界、原始计数/哈希/快照不变、失败批次回滚与输出脱敏。
- 本次本地验证：新增专项 12 项通过，连同相邻迁移/原导出脚本回归共 22 项通过；新增 Python 文件 Ruff 检查通过。仅有既有 pytest-asyncio/Starlette 弃用提示。
- 本次实现只运行本地测试和代码静态检查；没有连接真实数据库、读取项目 `.env`、执行线上回填、发布桌面包或部署。MySQL 实库 DDL、并发负载与线上性能尚未验证。
