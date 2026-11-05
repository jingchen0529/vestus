# 归档文档

这里放的是**已经不作为当前依据**的文档：被后续实现取代的方案、一次性快照、尚未启动的项目设计。
保留它们是为了追溯「当时为什么这么决定」，不是给新同学照着做。

要查现行口径，回到仓库根的 [README.md](../../README.md)；架构看 [docs/architecture.md](../architecture.md)，
接口与部署看 [docs/backend.md](../backend.md) 与 [docs/deploy-linux.md](../deploy-linux.md)。

| 文档 | 内容 | 归档原因 |
| --- | --- | --- |
| [admin-backend-proposal.md](admin-backend-proposal.md) | 首期后台建议：只用 admin / user / user_log 三张表 | 已被代理/平台集中分配的实现取代，表结构早已不是三张 |
| [embedded-browser-mvp-design.md](embedded-browser-mvp-design.md) | v0.1 方案：用户自己手填单条 HTTP 代理 | 代理改为管理员集中分配，桌面端不再接触代理口令 |
| [Vestus审计报告-2026-08-28.md](Vestus审计报告-2026-08-28.md) | 2026-08-28 对 `2cce55d` 的全量审计快照 | 快照类文档，其中若干阻断项（如密钥缺失不 fail-fast）此后已修，按它当任务清单会误导 |
| [desktop-auto-update-design.md](desktop-auto-update-design.md) | 桌面端自动更新 + 后台版本管理设计 | 项目未启动：`tauri-plugin-updater` 未接入，后台无版本表 |

## 归档约定

- 文档开头保留「已归档」横幅，并指向现行文档；
- 移动进本目录时同步修正相对链接（这里比 `docs/` 深一层，路径要补 `../`）；
- 只增不改：归档文档不再更新内容，需要修正的结论写进现行文档。
