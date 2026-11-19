# Task 1 实施报告

## 状态
已完成后端网络指标模型、严格请求 schema、持久化 repository/service、用户上报与管理员查询 API，以及 0019 Alembic 迁移。

## 改动
- 新增 `desktop_network_metric` ORM 模型和索引。
- 新增 `NetworkDiagnosticsReport`/`NetworkMetricSample`，限制协议版本、样本数、枚举、时延和响应大小，并校验路由与网络模式。
- 新增幂等 sampleId 写入、冲突检测、31 天保留清理、管理员绑定范围查询、分页和 nearest-rank p50/p95/失败率汇总。
- 注册 `/api/user/network-diagnostics` 与 `/api/admin/network-diagnostics`。

## 验证
- `python3 -m compileall -q app` 通过。
- `python3 -m pytest -q tests/api/test_error_contract.py` 通过（8 passed）。
- 任务指定的网络指标测试文件在执行时尚未存在，无法运行该 focused suite。

## 未验证与风险
- 未执行真实 MySQL Alembic upgrade 或部署环境验证。
- 未执行真实 bearer 用户/管理员端到端请求。
- retention cleanup 是 best effort，写入事务不受清理失败阻断。
