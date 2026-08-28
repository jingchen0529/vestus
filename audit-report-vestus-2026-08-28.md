# Fuck My Shit Mountain Audit Report

**Project:** Vestus  
**Audit mode:** full  
**Date:** 2026-08-28  
**Reviewer:** Codex（GPT-5 系列）

---

## 1. Executive Summary

Vestus 已经从最初的代理/桌面原型演进成一个边界清晰的完整产品雏形：当前同时包含 FastAPI 管理后端、React 管理后台、React/Tauri 桌面壳、Rust 本地代理与独立 Chromium、全局代理/平台配置、上传与品牌配置、MySQL 部署模板，以及 Windows、macOS、Linux 四目标发布流水线。相较初始提交 `9216fef`，当前基线 `2cce55d` 增加约 20,729 行、删除约 805 行；原先只面向 Windows 的桌面包也已扩展到四种原生构建目标。因此，从“功能是否已经形成闭环”看，答案是基本形成；从“能否作为稳定公开版本放心发布”看，答案仍是否定的。

代码质量并非失控。后端 52 项测试、Web 8 项测试、桌面 Node 12 项测试、Rust 86 项测试全部通过；两套 TypeScript/Vite 生产构建和桌面 surface boundary 检查也通过。认证分层、token_version 撤销、代理口令不跨 IPC、代理/直连不互相 fallback、上传路径防穿越、CSP API-origin 固定等安全边界都有真实实现和较有价值的测试。两个 npm lockfile 在本次安装审计中均报告 0 个已知漏洞。

稳定发布的主要阻断项集中在八个高风险问题：生产密钥缺失时不会启动失败；管理员防爆破、`maxSessions` 和强制改密等账号策略没有真正执行；同步数据库调用会阻塞 FastAPI 事件循环；并发删除可能移除最后一个超级管理员；改密成功但钥匙串清理失败时浏览器和代理仍可残留；仓库没有面向 push/PR 的后端、Web、MySQL CI；发布产物未形成签名、公证、校验和和可复现 Chromium 信任链。建议把当前状态定义为“功能候选版”，修完立即项并补齐真实 MySQL/安装包验收后，再称稳定版。

审计以 `2cce55d` 的已提交内容为主。审计期间工作区出现了用户并发暂存的 v0.1.4 版本号、DMG 配置和 DOCX 重命名；这些变更被完整保留，但未纳入本次通过性结论，也没有被本报告覆盖或回退。

### Score Dashboard

```text
Security        █████░░░░░  4.8  C   高覆盖下确认密钥 fail-open、账号控制未执法和桌面最小权限缺口
Stability       █████░░░░░  5.2  B   测试基础扎实，但同步 DB 阻塞、清理竞态和 readiness 假阳性会放大故障
Performance     ██████░░░░  6.2  B   常规规模可用；连接、响应体和部分列表仍缺硬上限，未做真实负载测试
Testing         ███████░░░  6.6  B   158 项测试全绿，但关键桌面 UI、生产 MySQL、迁移和 PR 门禁仍是空白
Maintainability █████░░░░░  5.4  B   边界意图清楚，但多个 1,000 行级核心模块与动态字典降低修改安全性
Design          █████░░░░░  5.2  B   关键安全边界设计较好，事务、fail-fast、状态所有权仍存在系统性缺口
Release         ████░░░░░░  4.3  C   四平台流水线已成形，但签名、公证、provenance、后端 CI 与回滚验证不足
─────────────────────────────────────
Overall         █████░░░░░  5.4  B
```

每个维度按 0.0–10.0 评分，分数越高越好；10 表示干净且可发布，0 表示不可接受。分数是基于证据的工程判断，不是按 finding 数量机械扣分。

### Finding Statistics

| Severity | Count | Confirmed | Suspected |
|----------|-------|-----------|-----------|
| Critical | 0 | 0 | 0 |
| High | 8 | 7 | 1 |
| Medium | 9 | 9 | 0 |
| Low | 0 | 0 | 0 |
| Info | 0 | 0 | 0 |
| **Total** | **17** | **16** | **1** |

## 2. Project Map

```text
Web 管理员浏览器
  └─ React 管理后台
       └─ /api/admin/* → FastAPI → SQLAlchemy → MySQL
            ├─ admin/user/user_log
            ├─ proxy/platform/system_setting
            └─ uploaded_file + 持久化上传目录

Tauri 桌面用户
  ├─ React 只持有非敏感视图状态
  └─ Rust 持有 token、代理口令、配置 lease 和浏览器进程
       ├─ 固定 HTTPS API → 同步全局代理/平台配置
       ├─ 127.0.0.1 随机端口本地适配器
       │    ├─ 默认路径 → 带认证上游 HTTP 代理
       │    └─ bypassHosts → 经 DNS 安全检查后直连
       └─ 平台 ID allowlist → 独立 Chromium + 临时 profile

发布与运维
  ├─ GitHub Actions 标签/手工工作流 → 四目标原生桌面安装包
  └─ Linux systemd + Nginx + MySQL → 手工部署、备份与恢复
```

关键状态所有权总体明确：后端数据库是账号、代理、平台和品牌配置的源；Rust 是桌面 token、代理口令、适配器和浏览器生命周期的源；React 只保存展示状态和主题偏好。风险最集中的边界是启动配置、账号策略、数据库事务/事件循环、Rust 生命周期清理、浏览器临时数据、公开上传生命周期及发布产物信任链。

覆盖说明：盘点 223 个文件，系统性审阅所有一方 Python、Rust、TypeScript/React、测试、SQL、CI、部署和说明文档；排除生成的 Tauri schema、图片/Docx 二进制内容、node_modules、dist、target、缓存和 Git 对象。实际执行 `pytest`、Node tests、Rust tests、两套前端 build、surface boundary、ruff、mypy、rustfmt 与 clippy 尝试。没有启动真实 MySQL、Nginx、四平台安装包、浏览器辅助技术或生产监控环境；实时 Python/Rust CVE 数据库也未扫描。

### Coverage Matrix

| Dimension | Coverage | Evidence inspected | Exclusions / limits |
|-----------|----------|--------------------|---------------------|
| Architecture | High | 入口、依赖方向、状态所有权、API/IPC/DB/文件边界、全部一方模块 | 未做动态调用图或提交耦合统计 |
| Security | High | 56 个路由声明、认证/授权、密钥、上传、代理、CSP、Tauri capabilities、npm audit | 未做渗透测试；Python/Rust 实时 CVE 未扫描 |
| Stability | High | 错误路径、timeout、锁、事务、生命周期、158 项测试 | Windows/Linux 条件路径未在对应 OS 实机运行 |
| Performance | Medium | 查询、列表、缓冲、连接/task、前端 bundle | 无 MySQL 压测、profiling 或浏览器 performance trace |
| Testing | High | 全部测试源码与四套实际测试命令 | 无真实 MySQL、E2E 浏览器、安装/升级/恢复测试 |
| Maintainability | High | 全部一方源码、行数、ruff、mypy、rustfmt、clippy | 未运行复杂度专用扫描器 |
| Design | High | principles rubric 对照边界、职责、错误、状态和类型 | 未做正式 ADR 访谈 |
| Release | Medium | 完整 release workflow、打包脚本、Tauri 配置、部署文档 | 未实际生成/安装四平台 release artifact |
| Documentation | High | README 与 docs 下全部 Markdown、部署模板、代码契约 | DOCX 内容未渲染核对；并发重命名未覆盖 |
| Configuration | High | 所有 `VESTUS_*` 读取、env 示例、Tauri/Nginx/systemd 配置 | 未读取真实生产环境变量或密钥 |
| Observability | High | audit log、request ID、health、异常处理、部署日志说明 | 无生产日志、指标、告警或 SLO 配置可检查 |
| Data Integrity | High | 事务、锁、migration、约束、备份文档与并发测试 | 未在真实 MySQL 执行迁移、互删或恢复 |
| Privacy | High | PII、上传、日志、profile、删除/公开读取生命周期 | 无外部数据政策、备份保留配置 |
| Accessibility | Medium | 登录、改密、对话框、toast、label、keyboard 源码 | 未运行浏览器、axe、屏幕阅读器或缩放验收 |
| Supply Chain | Medium | lockfile、Actions、npx Chromium、artifact 发布、npm audit | 未运行 SBOM、签名或 Python/Rust advisory scanner |
| Cost | Medium | DB round-trip、日志/上传增长、连接/task、外部探测 | 无账单、流量、存储或容量数据 |
| AI / LLM Safety | Not assessed | 未发现模型、RAG、prompt、agent 或 tool-call 运行面 | inventory 的 AI 命名信号为误报，项目不适用 |
| Fallback | High | secret fallback、health、catch/pass、UI 默认、direct/proxy fallback | 未做故障注入到所有外部服务 |
| Testing Authenticity | High | 测试是否走真实 app/FS/socket/并发及字符串检查 | UI 测试缺运行型浏览器，因此该部分置信度受限 |
| Type Safety | High | strict tsconfig、`any`/assertion、mypy、Rust unsafe/unwrap 搜索 | 无 pyright；外部响应无统一 schema scanner |
| Frontend State | High | 所有 App/effect/loader、认证、loading/error/empty 路径 | 无真实浏览器竞态或可访问性树验证 |
| Backend API | High | 所有路由、DTO、状态码、认证、列表、事务和错误响应 | 未做 OpenAPI contract diff 或真实反代测试 |
| Dependency Weight | Medium | 直接依赖、import 使用、lockfile、bundle 产物大小、cargo tree 取证 | 未做 bundle analyzer 或跨平台二进制体积对比 |
| Code Consistency | High | ruff、mypy、rustfmt、clippy、错误/命名/配置模式搜索 | TypeScript 未配置 ESLint |
| Comment Coverage | Medium | README/docs、模块注释、TODO/FIXME/HACK 与公开 Rust API抽查 | 未要求所有简单 getter/DTO 都有注释 |

## 3. Top Risks

| Priority | Finding | Severity | Summary |
|----------|---------|----------|---------|
| 1 | F-01 启动密钥 fail-open | High | 密钥缺失或示例值会被接受，可造成 token/密文失效甚至已知签名密钥风险 |
| 2 | F-02 账号保护策略未落实 | High | 管理员无限尝试、用户计数并发丢失、`maxSessions` 不限会话且密码生成非密码学随机 |
| 3 | F-03 强制改密契约完全失效 | High | reset 明确写入 false，后端不拦配置，桌面已写组件却从不渲染 |
| 4 | F-04 同步数据库阻塞事件循环 | High | MySQL 变慢时单 worker 的所有 async endpoint 可同时停顿 |
| 5 | F-05 改密清理失败会残留运行资源 | High | 远端密码已改但钥匙串删除失败时 Chromium、adapter 与 watchdog 清理链断裂 |
| 6 | F-06 最后超级管理员并发删除竞态 | High | 两个超级管理员互删可能同时通过 count 检查并留下零管理员 |
| 7 | F-07 CI 未覆盖主线与生产数据路径 | High | 只有标签/手工桌面 CI，后端、Web、MySQL migration 不受合并门禁保护 |
| 8 | F-08 发行产物缺少完整信任链 | High | macOS 未签名公证且指导移除 quarantine，Chromium/Actions/provenance 也未固定验证 |
| 9 | F-09 业务写与审计日志不原子 | Medium | 高影响操作成功后日志写失败会被静默吞掉 |
| 10 | F-10 readiness 会给出可路由假阳性 | Medium | 初始化/迁移失败后 `SELECT 1` 仍可能让健康接口返回 HTTP 200 |
| 11 | F-11 品牌设置更新会部分提交 | Medium | 一个 API 请求拆成多事务，中途失败后对外配置可能是半新半旧 |
| 12 | F-12 多个外部输入路径缺硬资源上限 | Medium | 本地代理连接、HTTP 响应体和用户列表可放大 FD、内存或 DB 压力 |
| 13 | F-13 数据保留与删除生命周期不闭环 | Medium | 孤儿上传仍公开、已删用户 PII/日志长期保留、崩溃 profile 无启动清扫 |
| 14 | F-14 桌面本机信任边界偏宽 | Medium | `core:default`、无认证 loopback adapter 与私网 bypass 扩大本地攻击面 |
| 15 | F-15 管理 UI 把失败/未知状态当作正常 | Medium | 401 不退出、health 失败仍绿色、乱序请求可覆盖最新筛选结果 |

## 4. Detailed Findings

### Finding: F-01 启动密钥缺失或占位值不会阻止服务启动

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: 后端 token 签名、代理口令加密、启动配置
- Principle: Fail-Fast（4.4）、Configuration Over Hardcoding（9.1）、Fail on Missing Configuration（9.2）
- Evidence:
  - File: `security.py:29,75-90`; `.env.example:5-9`; `db.py:547-578`
  - Function / Module: `_secret()`、`_proxy_fernet()`、`Database.initialize()`
  - Relevant behavior: 未配置密钥时使用进程内随机值；长度、熵和公开模板占位值均不校验，服务仍可启动。
- Problem: 必需的安全配置采用 fail-open。随机密钥会让不同进程或重启之间的 token 与代理密文互不兼容；直接复制示例值则会把公开已知值变成生产签名材料。
- Why it matters: 这是认证和代理凭据的根信任。它失效时既可能造成持续 401/500，也可能让攻击者在已知签名值场景下伪造账户 claims。
- Realistic failure scenario: 运维忘记替换 env 示例，或使用多个 worker；一个进程签发的 token 被另一个拒绝，已有代理口令在重启后无法解密，桌面配置持续失败。
- Minimal fix: 启动时要求两个密钥明确存在、达到最小随机强度并拒绝已知模板值；不满足立即退出，不能进入 readiness。
- Better long-term fix: 引入单一配置 schema，区分 secret/non-secret，记录密钥版本并为代理密文提供显式轮换迁移流程。
- Regression test suggestion: 缺失、过短、模板值都应启动失败；两个独立进程用同一配置互验 token/密文；更换代理密钥必须走迁移测试。
- Estimated effort: 2–4 小时

### Finding: F-02 登录防护、会话上限与凭据生成没有形成真实控制

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: 管理员/桌面用户登录、并发会话、管理端生成密码
- Principle: Appropriate Defensive Programming（4.5）、Least Privilege（4.6）、Unbounded Resources（10.2）
- Evidence:
  - File: `app.py:156-165,625-638`; `db.py:1250-1257`; `security.py:111-135`; `web/src/lib/utils.ts:27-44`
  - Function / Module: `_login()`、`record_failed_login()`、`create_access_token()`、`generateRandomPassword()`
  - Relevant behavior: 管理员失败登录没有持久锁定或 IP 速率限制；用户失败计数为无锁读改写；`maxSessions` 只存储/序列化；管理端以 `Math.random()` 生成实际账户密码。
- Problem: 多个看起来像安全控制的字段和 UI 实际不具备控制效果，且失败日志会随随机用户名请求持续增长。
- Why it matters: 管理员登录是最高权限入口；桌面 token 可读取含可逆代理口令的配置。虚假的会话上限也会让运营方错误评估共享账号或泄露后的影响。
- Realistic failure scenario: 公网攻击者持续猜测常见管理员账号；共享凭据在多个设备同时登录且全部 token 有效；管理员使用可预测性不足的自动生成密码作为长期凭据。
- Minimal fix: 在网关/应用增加 IP+账号限速，管理员也纳入锁定；用户失败计数改为原子更新；实现服务端 session/JTI 上限或删除 `maxSessions`；密码改用 `crypto.getRandomValues()`。
- Better long-term fix: 建立统一账号策略服务，集中处理登录预算、session 撤销、密码生命周期、审计采样和保留期。
- Regression test suggestion: 管理员 N 次失败锁定；并发失败计数精确；`maxSessions=1` 时第二次登录拒绝或撤销第一枚 token；静态测试禁止密码生成路径使用 `Math.random`。
- Estimated effort: 1–3 天

### Finding: F-03 “临时密码必须先修改”在后端、桌面 UI 和测试中均未成立

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: 管理员重置桌面用户密码、桌面首次登录流程
- Principle: Principle of Least Surprise（3.1）、Fail-Fast（4.4）、Handle All Branches（6.3）
- Evidence:
  - File: `README.md:115`; `docs/desktop-user-guide.md:54-63`; `app.py:870-877,1174-1180`; `desktop/src/App.tsx:275-326`; `desktop/src/components/auth/ChangePasswordCard.tsx:16-55`; `tests/test_auth_api.py:130-148`
  - Function / Module: `reset_user_password()`、`user_desktop_config()`、`MainLayout`、`ChangePasswordCard`
  - Relevant behavior: reset 明确写入 `must_change_password=False`；desktop-config 不检查该标志；桌面虽然导入并实现改密组件，渲染树却从不使用；现有测试还断言重置后可直接读取配置。
- Problem: 文档承诺的关键凭据生命周期控制是死代码和反向测试。若有人通过 PATCH 手工置 true，桌面也会忽略标志并继续进入主界面。
- Why it matters: 临时密码通常经管理员渠道传递，风险高于用户自设密码；截获者可以直接取得平台清单和代理配置，运营人员却会误以为首次改密已经强制执行。
- Realistic failure scenario: 管理员重置密码并通过聊天发送，消息被他人看到；对方直接登录并同步代理/平台，而真实用户没有任何强制改密提示。
- Minimal fix: reset 设为 true；认证后只允许 `me/change-password/logout`；desktop config 返回明确 403；桌面在同步前渲染 `ChangePasswordCard`，成功后要求重新登录。
- Better long-term fix: 把账户状态建模为显式状态机，并用后端契约测试、Rust IPC 测试和 React 集成测试共同约束允许操作集合。
- Regression test suggestion: 登录返回强制改密时不得调用 config；config 返回 403；改密后旧 token 失效并回登录页，新密码登录才可同步。
- Estimated effort: 4–8 小时

### Finding: F-04 FastAPI 的 async 路径直接执行同步 SQLAlchemy

- Severity: High
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: 全部认证依赖、账号/配置/日志 API、health
- Principle: No Blocking Calls in Async Context（10.1）、Timeout Every External Call（10.4）
- Evidence:
  - File: `app.py:553-584,625-675,765-1233`; `db.py:506-539`; `deploy/vestus.service.example:17-19`
  - Function / Module: `current_account()`、`_login()`、大多数 async route、同步 `Database`
  - Relevant behavior: `async def` handler/dependency 直接获取连接并执行同步 DB；部署模板又使用单 worker。运行探针确认延迟 200ms 的 `db.ping()` 会让纯内存 `/` 同样延迟约 200ms。
- Problem: 任何 MySQL 网络抖动、连接池等待或慢查询都会阻塞事件循环，而不是只影响当前请求。
- Why it matters: 这是系统性可用性问题；登录、健康检查、配置 lease 和管理请求会一起出现尾延迟与超时级联。
- Realistic failure scenario: MySQL 短时卡顿数秒，桌面 lease 检查和管理员请求堆积，单 worker 无法及时处理甚至被反代判定超时。
- Minimal fix: 将纯同步 handler/dependency 改成普通 `def` 让 FastAPI 线程池承载，或统一以 threadpool 包住 repository 调用。
- Better long-term fix: 在服务层形成清晰 sync/async 边界，并为 DB 连接、查询和线程池设置预算、饱和指标与超时。
- Regression test suggestion: 并发一个人为阻塞的 DB 请求与快速 `/` 请求，断言后者在短 deadline 内完成；再加入连接池耗尽测试。
- Estimated effort: 0.5–2 天

### Finding: F-05 远端改密成功但钥匙串删除失败时运行资源不会清理

- Severity: High
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: 桌面改密、浏览器/代理生命周期、lease watchdog
- Principle: Don’t Swallow Errors（6.1）、Cancel Safety（10.3）
- Evidence:
  - File: `desktop/src-tauri/src/auth.rs:676-719,938-952`; `desktop/src-tauri/src/commands.rs:497-514`
  - Function / Module: `DesktopAuthState::change_password()`、`desktop_change_password()`、lease watchdog
  - Relevant behavior: 服务端成功后先增加 auth generation；若本地 `delete_token` 失败，命令返回 Err，而 `close_all/teardown` 只在 result 为 Ok 时运行；旧 watchdog 因 session_changed 直接退出。
- Problem: 远端安全状态已经改变，本地清理却由一个次要的钥匙串错误决定，形成不可恢复的半完成状态。
- Why it matters: 已打开网页、持有代理凭据的 adapter 和 Chromium 可继续运行到应用退出，违反改密后立即终止旧会话的安全预期。
- Realistic failure scenario: macOS/Windows 钥匙串被锁定或临时不可写；用户收到“改密失败”，但服务器密码和 token 已变化，旧浏览器仍保持平台会话。
- Minimal fix: HTTP 成功后无条件先关闭浏览器、teardown、清内存，再把钥匙串清理错误作为次级告警返回。
- Better long-term fix: 将远端变更、本地凭据清理和运行时 teardown 建模为可补偿事务，并让 logout/改密共享同一幂等清理流程。
- Regression test suggestion: 注入固定失败的 credential store，模拟远端成功，断言 close_all 与 teardown 必定执行，watchdog 不残留。
- Estimated effort: 4–8 小时

### Finding: F-06 并发删除可能移除最后一个有效超级管理员

- Severity: High
- Confidence: Medium
- Category: Stability
- Status: Suspected
- Affected area: 超级管理员删除不变量、MySQL 并发事务
- Principle: No Shared Mutable State Without Synchronization（5.4）、Fail-Fast（4.4）
- Evidence:
  - File: `app.py:993-1006`; `db.py:1213-1228`
  - Function / Module: `delete_admin()`、`soft_delete_admin()`
  - Relevant behavior: 删除在独立事务中无锁执行 `COUNT(active super_admin)`，随后更新各自目标；该路径没有像其他 invariant 路径那样锁定稳定行或全部 active 超级管理员。
- Problem: count-then-update 不是原子 invariant，两个事务可基于相同旧快照做出互相矛盾的“仍有另一个管理员”判断。
- Why it matters: 最终零 active 超级管理员会导致后台无法正常恢复，只能直接修改数据库。
- Realistic failure scenario: 系统恰有 A、B 两个超级管理员；A 删除 B 与 B 删除 A 同时发生，两边均读到 count=2 并分别提交。
- Minimal fix: 在单事务内锁定固定 singleton 行或所有 active 超级管理员，再重新读取目标和计数后更新。
- Better long-term fix: 统一所有角色变更、停用、删除路径到一个原子 admin invariant service，避免 app/db 两套规则漂移。
- Regression test suggestion: 在真实 MySQL 上用 barrier 同时互删，断言恰有一个操作失败且始终至少保留一个 active 超级管理员。
- Estimated effort: 4–8 小时

### Finding: F-07 CI 只在桌面标签/手工流程运行，后端、Web 与真实 MySQL 不受门禁保护

- Severity: High
- Confidence: High
- Category: Testing
- Status: Confirmed
- Affected area: 主线合并、后端/Web 发布、migration 与生产数据一致性
- Principle: Test Behavior, Not Implementation（8.1）、Fail-Fast（4.4）
- Evidence:
  - File: `.github/workflows/release.yml:13-16,148-157`; `tests/conftest.py:11-26`; `deploy/migrations/2026-08-27-settings-and-uploads.sql:1-56`
  - Function / Module: 唯一 GitHub workflow、pytest fixture、MySQL migration
  - Relevant behavior: workflow 只由桌面 tag 或手工触发，只测试 desktop Node/Rust；没有 push/PR job 跑后端、Web、ruff/mypy、真实 MySQL 或 migration/restore。后端 52 项测试固定使用 SQLite。
- Problem: 本地已有的高价值测试没有变成持续门禁，生产数据库差异和升级 SQL 也没有被自动验证。
- Why it matters: 代码可以在后端 API、管理 UI 或迁移已回归的情况下合并，直到手工部署或用户使用才暴露。
- Realistic failure scenario: SQLAlchemy 逻辑在 SQLite 全绿，但 MySQL JSON、锁或迁移语法失败；tag 流水线仍只构建桌面并发布与坏后端不兼容的客户端。
- Minimal fix: 新增 PR/push CI，运行 pytest、Web test/build、desktop test/build/surface、Rust fmt/clippy/test；启动 MySQL 8.4 执行空库初始化、旧库迁移与关键并发测试。
- Better long-term fix: 建立版本化兼容矩阵和 release gate，覆盖 backend schema N/N-1、桌面版本、安装、升级、恢复与回滚演练。
- Regression test suggestion: CI 从旧 schema fixture 升级两次仍成功；真实 MySQL 互删与代理唯一性并发测试；required checks 阻止失败合并。
- Estimated effort: 1–3 天

### Finding: F-08 桌面发行包没有形成签名、公证、校验和与可复现依赖链

- Severity: High
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: macOS/Windows/Linux 安装包、GitHub Actions、内置 Chromium
- Principle: Least Privilege（4.6）、Configuration as a Single Source（9.1）
- Evidence:
  - File: `.github/workflows/release.yml:55-57,120-146,208-258`; `desktop/scripts/prepare-chromium.mjs:27-61,76-96`; `desktop/scripts/generate-dmg-background.mjs:216-224,553-561`; `README.md:73-81`
  - Function / Module: release workflow、Chromium download、DMG 安装提示
  - Relevant behavior: Actions 以可移动 tag 引用；Chromium 通过未进入项目 lockfile 的 `npx` 在发布时下载并按 mtime 选 cache；release 未生成 SBOM、hash、签名或 provenance；macOS 明确未签名公证，DMG 还提示以 sudo 删除 quarantine。
- Problem: 用户没有可靠方式确认安装包和内置浏览器与仓库源码一致，且官方提示会绕过系统的下载隔离保护。
- Why it matters: 该应用接触登录口令、token 和代理流量；发行链被替换后的影响远高于普通展示型客户端。
- Realistic failure scenario: registry/CDN、Actions tag 或 release asset 被替换；用户按 DMG 指引移除 quarantine 后直接运行篡改程序。
- Minimal fix: macOS Developer ID 签名、公证与 stapling；Windows 代码签名；生成 SHA-256；把 exact Playwright 纳入 lockfile并校验明确 revision；Actions pin commit SHA。
- Better long-term fix: 生成 SBOM、SLSA provenance 和可验证发布清单，统一签名全部 artifact 与 Chromium manifest，并在 CI 中验签。
- Regression test suggestion: CI 执行 codesign/spctl/notarization、Windows signature verification、hash manifest 校验；cache 中有多个 Chromium revision 时只能选择声明版本。
- Estimated effort: 2–5 天，另含证书准备

### Finding: F-09 业务写入和审计日志分属两个事务，日志失败被静默吞掉

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: 用户/管理员/代理/平台/设置高影响操作审计
- Principle: Don’t Swallow Errors（6.1）、Don’t Lose Error Context（6.2）、No Hidden Side Effects（5.3）
- Evidence:
  - File: `app.py:611-617,1127-1136`; `db.py:1266-1271`
  - Function / Module: `_log()`、所有管理 mutation、`Database.add_log()`
  - Relevant behavior: 业务 mutation 先提交；随后 `_log()` 另开事务。任何 SQLAlchemyError 直接 `pass`。故障注入确认创建用户仍 201，但对应审计记录为 0。
- Problem: 系统声称记录关键操作，却不能保证业务事实与审计事实一致，也没有告警说明审计链已经断开。
- Why it matters: 密码重置、账号删除和代理替换恰是事故调查最需要的证据；静默缺失会造成不可追踪的管理变更。
- Realistic failure scenario: 日志表满、schema 漂移或短暂写故障；业务操作成功，运营人员事后只能看到数据变化而找不到操作者与请求。
- Minimal fix: 高影响 DB mutation 与 audit row 使用同一 transaction；至少不能完全吞错，应发结构化错误与指标。
- Better long-term fix: 若必须解耦，使用同事务 outbox，再由可靠 worker 投递不可变审计存储并支持重放/告警。
- Regression test suggestion: audit INSERT 失败时 mutation 整体回滚；或 outbox 仍提交且最终补写，失败产生可检测告警。
- Estimated effort: 1–2 天

### Finding: F-10 初始化或迁移失败后 readiness 仍可能返回 HTTP 200

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: 后端启动、负载均衡健康判断、旧 schema 升级
- Principle: Fail-Fast（4.4）、Don’t Lose Error Context（6.2）
- Evidence:
  - File: `db.py:547-578`; `app.py:670-675`; `docs/deploy-linux.md:135-144`
  - Function / Module: `Database.initialize()`、`ping()`、`healthz()`
  - Relevant behavior: schema/bootstrap/归一化错误只保存字符串；后续 `SELECT 1` 成功可把 available 恢复为 true；`/healthz` 即使 degraded 也永远 HTTP 200。
- Problem: “进程活着”“数据库可连”“业务 schema 可用”被混成一个弱信号，无法作为 readiness gate。
- Why it matters: 漏跑迁移的实例会继续接收流量，真实业务请求才因缺列报错；故障定位也缺失 initialization error 的安全关联信息。
- Realistic failure scenario: 部署新代码但未运行 migration；Nginx/探针认为服务正常，桌面 config 和设置端点持续 503/500。
- Minimal fix: 关键初始化失败直接退出，或拆分 `/livez` 与 `/readyz`；readiness 在初始化错误、关键表/版本缺失、DB 不可用时返回 503。
- Better long-term fix: 引入 schema version 表、向前/向后兼容检查和部署 gate，把迁移状态作为可观测信号。
- Regression test suggestion: 旧 schema、缺关键列、DB 不可达均 readiness=503；完整 schema 才 200；liveness 不因短暂 DB 故障重启进程。
- Estimated effort: 2–4 小时

### Finding: F-11 品牌设置的一次更新会拆成多个独立事务

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: 产品名、Logo、后台标题和主题色配置
- Principle: No Hidden Side Effects（5.3）、Business Logic Independence（7.2）
- Evidence:
  - File: `db.py:1317-1387`; `app.py:770-802`
  - Function / Module: `set_setting()`、`set_branding()`、`update_admin_settings()`
  - Relevant behavior: 每个 key 独立 session/commit，随后又多次读取；故障注入确认第二项失败时第一项已经持久化。
- Problem: 一个 API command 不具备原子性，失败响应不能代表“没有改变”。
- Why it matters: 桌面与 Web 会同时读取品牌配置，部分提交会产生半新半旧的跨客户端体验，也让审计与重试语义变得含糊。
- Realistic failure scenario: 管理员同时更新产品名和 Logo，第二次 DB 写失败；接口返回错误，但公开产品名已经变化而 Logo 仍旧。
- Minimal fix: 单个 session/transaction 中完成全部校验和 upsert，最后返回同一事务快照。
- Better long-term fix: 把 branding 作为一个有版本的聚合体存储，并以 revision 驱动缓存失效与客户端同步。
- Regression test suggestion: 第 N 项写入失败后所有 key 保持旧值；并发更新结果只能是完整旧版或完整新版。
- Estimated effort: 2–4 小时

### Finding: F-12 连接、响应体和列表三个外部输入面缺少硬资源上限

- Severity: Medium
- Confidence: High
- Category: Performance
- Status: Confirmed
- Affected area: Rust 本地 adapter、桌面 HTTP 客户端、后端用户列表
- Principle: Unbounded Resources Must Not Grow Forever（10.2）、Timeout Every External Call（10.4）
- Evidence:
  - File: `desktop/src-tauri/src/adapter.rs:79-105,139-142`; `desktop/src-tauri/src/httpio.rs:41-69`; `desktop/src-tauri/src/auth.rs:1011-1024`; `app.py:1122-1124`; `db.py:700-708`
  - Function / Module: adapter accept loop、`read_head()`、`decode_success_json()`、`list_users()`
  - Relevant behavior: 每个连接无条件 spawn，初始头读取无 deadline；1 MiB 响应上限在 `bytes()` 全量缓冲后才检查；用户列表无分页并返回含 PII 的所有记录。
- Problem: 三个路径都把调用方可控规模直接转成 FD、task、内存、DB/网络负载，没有真实预算。
- Why it matters: 正常故障、恶意网页或同机进程都可让桌面代理不可用；大用户量会让管理端一次加载放大成全表与大 JSON。
- Realistic failure scenario: 同机进程保持大量半包连接，或错误 API 返回超大 chunked body；桌面耗尽 FD/OOM。数万用户时管理页单请求拖慢数据库和 worker。
- Minimal fix: adapter 加 semaphore 和 header deadline；流式累计响应并在 N+1 字节停止；users 加最大 page size 与精简列表 DTO。
- Better long-term fix: 为网络、DB、上传、日志和后台任务建立统一资源预算、背压和饱和度指标。
- Regression test suggestion: idle 连接超过上限被拒绝；chunked body 在阈值处停止；超过 page size 的用户响应稳定分页且无遗漏。
- Estimated effort: 1–2 天

### Finding: F-13 上传、用户 PII、日志和浏览器 profile 缺少闭环保留/删除策略

- Severity: Medium
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: 公开上传文件、用户隐私字段、审计日志、临时 Chromium 数据
- Principle: Least Privilege（4.6）、Unbounded Resources（10.2）、Don’t Swallow Errors（6.1）
- Evidence:
  - File: `app.py:708-762`; `db.py:143-169,246-295,1203-1211`; `desktop/src-tauri/src/browser.rs:66-74,338-371`; `README.md:77-78`
  - Function / Module: upload/公开读取、`soft_delete_user()`、`cleanup_profile()`、BrowserSessionManager 初始化
  - Relevant behavior: 取消引用 Logo/平台图后文件和 metadata 仍永久公开；软删保留 phone/company/remark；日志 IP/UA 无 retention；profile 删除失败静默放弃，异常退出后下次启动不清扫。
- Problem: “删除”与“临时”只在正常 UI 路径上成立，没有覆盖派生数据、公开 URL、崩溃或长期备份。
- Why it matters: 误上传文件和个人数据可能在业务不再需要后继续可访问/可恢复；README 对 Cookie/profile 清理的绝对表述也超出实现保证。
- Realistic failure scenario: 用户撤下曾误传的文档，但旧 URL 已进入聊天后仍匿名可读；桌面崩溃后 profile 长期留在 cache；已删除用户的 PII 继续存在于库和备份。
- Minimal fix: 为上传增加引用检查、受权删除与保留期；软删到期匿名化 PII；日志设 retention；启动时清扫带 marker 的 stale profile 并记录失败。
- Better long-term fix: 建立数据 inventory、分类、owner、retention、delete/export 和备份例外的统一治理策略及定时 reconciliation。
- Regression test suggestion: 取消最后引用并清理后旧 URL 404；保留期到期 PII 匿名化；模拟崩溃目录在下次启动被安全清扫。
- Estimated effort: 2–4 天

### Finding: F-14 桌面端对 WebView、同机进程和私网直连的最小权限仍偏宽

- Severity: Medium
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: Tauri capability、本地 loopback adapter、bypassHosts 私网访问
- Principle: Least Privilege（4.6）、Appropriate Defensive Programming（4.5）
- Evidence:
  - File: `desktop/src-tauri/capabilities/default.json:6-12`; `desktop/src-tauri/src/adapter.rs:67-110,136-170`; `desktop/src-tauri/src/bypass.rs:198-220`; `README.md:155-158`
  - Function / Module: default capability、adapter listener、`is_safe_direct_address()`
  - Relevant behavior: `core:default` 展开为比 UI 所需更广的 path/image/menu/tray/webview 权限；随机 loopback 端口没有客户端认证；bypass 明确允许 RFC1918、CGNAT 和 IPv6 ULA。
- Problem: 三处设计都把“本机环境可信”作为隐含前提，但应用本身处理不可信网页、DNS 和本机其他进程。
- Why it matters: WebView XSS、恶意本机进程或被接管的 allowlisted 域名可分别获得更广 Tauri 能力、借用上游代理身份或把直连变成内网跳板。
- Realistic failure scenario: 同机进程扫描 socket 后通过 adapter 使用组织代理；通配 bypass 域名 DNS 重绑定到内网管理面；WebView 注入利用默认 capability 扩大本地访问面。
- Minimal fix: 移除 `*:default` 并列精确 capability；明确本机攻击者威胁模型并增加进程隔离/会话证明；公网 bypass 默认拒绝非全局地址，私网需独立显式 CIDR 策略。
- Better long-term fix: 为桌面建立 threat model 与权限清单，把 WebView、IPC、socket、DNS、文件和进程边界纳入持续安全测试。
- Regression test suggestion: capability 不能含 default；未授权本地连接被拒绝；RFC1918/ULA 默认拒绝，只有明确私网 policy 才能放行指定 CIDR。
- Estimated effort: 1–3 天

### Finding: F-15 管理后台会把会话失效、健康失败和旧请求结果继续表现为有效状态

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: Web AuthProvider、API client、sidebar health、列表搜索/筛选
- Principle: Principle of Least Surprise（3.1）、Don’t Swallow Errors（6.1）、Handle All Branches（6.3）
- Evidence:
  - File: `web/src/lib/api-client.ts:60-95`; `web/src/hooks/use-auth.tsx:20-63`; `web/src/components/layout/sidebar.tsx:76-95,364-419`; `web/src/App.tsx:114-173`
  - Function / Module: `request()`、AuthProvider、Sidebar health、resource loaders
  - Relevant behavior: 数据请求的 401 只作为普通错误抛出，不清会话；health fetch 失败仍显示绿色“正常/已连接”；筛选 loader 无取消或 request revision，旧响应可覆盖新结果。
- Problem: UI 缺少明确的 unknown/expired/stale 状态，把错误或旧数据继续当作可信视图。
- Why it matters: 管理员可能基于错误健康信号继续操作，或在过期会话中反复失败而仍看到旧敏感数据；搜索结果也可能与当前条件不一致。
- Realistic failure scenario: 会话过期且数据库不可达；壳层仍显示管理员和绿色健康状态。用户快速输入筛选，较慢的旧请求最后返回并覆盖新条件。
- Minimal fix: 401 发布单一 auth-expired 事件并清状态；health 建模 loading/healthy/degraded/unreachable；loader 使用 AbortController 或 requestId 只接纳最新响应。
- Better long-term fix: 每个资源使用显式 `{data, loading, error, queryKey, revision}` 状态模型，并统一错误、鉴权和重试策略。
- Regression test suggestion: 任一数据请求 401 后只退出一次；health reject 不显示绿色；旧 Promise 后返回不能覆盖最新筛选。
- Estimated effort: 1–2 天

### Finding: F-16 登录、改密与 toast 的语义/键盘无障碍不完整

- Severity: Medium
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: Web/桌面认证工作流、消息反馈
- Principle: Semantic Structure、Keyboard Focus、Error State（Accessibility audit）
- Evidence:
  - File: `desktop/src/components/auth/LoginCard.tsx:100-143`; `desktop/src/components/auth/ChangePasswordCard.tsx:82-122`; `web/src/components/auth/login-card.tsx:134-145`; `desktop/src/components/ui/toast.tsx:66-94`
  - Function / Module: 登录输入、密码可见按钮、改密表单、ToastProvider
  - Relevant behavior: label 无 `htmlFor`/稳定 id；密码显示按钮被 `tabIndex=-1` 排除键盘流或缺 accessible name；toast 没有 live region，关闭按钮缺名称。
- Problem: 关键认证输入和反馈没有可靠的程序化名称、键盘操作和辅助技术播报。
- Why it matters: 键盘或屏幕阅读器用户可能无法辨认当前/新密码字段、切换可见性，或获知登录/改密失败原因。
- Realistic failure scenario: 用户只用键盘登录，无法聚焦显示密码按钮；改密失败 toast 不播报且错误没有关联到对应输入。
- Minimal fix: 输入加 id/name 与 `htmlFor`；按钮加 `aria-label/aria-pressed` 并留在 Tab 顺序；错误用 `aria-describedby`；toast 加合适的 `role`/`aria-live`。
- Better long-term fix: 引入 Testing Library + axe 的认证工作流测试，并建立键盘、focus、缩放、对比度和 loading/error 的 UI 验收清单。
- Regression test suggestion: 按 role/name 查询所有控件；模拟 Tab/Enter；axe 无关键违规；登录和改密错误在 live region 可观察。
- Estimated effort: 4–8 小时

### Finding: F-17 大型核心模块与弱边界类型降低了安全变更的可验证性

- Severity: Medium
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: Python API/DB、Rust auth/sync、Web/Tauri 响应边界
- Principle: SRP（1.1）、File Size Limit（1.2）、Function Size（1.3）、Appropriate Defensive Programming（4.5）
- Evidence:
  - File: `app.py:1-1269`; `db.py:1-1395`; `desktop/src-tauri/src/auth.rs:1-1471`; `desktop/src-tauri/src/commands.rs:255-461`; `web/src/lib/api-client.ts:29-95`; `desktop/src/services/authService.ts:62-84`
  - Function / Module: 整体 API/repository/auth 文件、`sync_desktop_config()`、客户端 runtime boundary
  - Relevant behavior: 三个核心文件超过 1,000 行；sync 函数约 207 行；后端 mypy 有 9 个错误并广泛使用 `Dict[str, Any]`；TypeScript 将外部数据直接 `as T` 或 `any` 后静默补默认值。
- Problem: 安全、事务、网络、状态和序列化职责聚在同一文件/函数，外部边界又缺 runtime schema，使编译器和 review 都难以证明所有错误分支一致。
- Why it matters: F-05、F-06、F-11 这类问题正来自清理顺序、并发 invariant 和事务语义分散；版本错配还可绕过 TypeScript 的表面 strict。
- Realistic failure scenario: 后端字段改名或桌面状态新增分支，客户端仍把畸形数据强转为合法模型；维护者在巨型模块修一条路径却漏掉 legacy/并发路径。
- Minimal fix: 先修 mypy 9 项；为 auth claims/DTO/外部响应加 TypedDict、Pydantic 或 type guard；按已有测试渐进拆小最危险的 transaction/lifecycle 单元。
- Better long-term fix: 建立明确 routes/services/repositories/models 与 AuthHttpClient/CredentialSession/DesktopSyncTransaction 边界，并用依赖方向检查守住结构。
- Regression test suggestion: mypy 零错误；关键 JSON 缺字段/错类型在边界失败；拆分前后保留全部并发、撤销、CSRF、上传与 adapter 行为测试。
- Estimated effort: 3–7 天，分阶段实施

## 5. Architecture Analysis

- Coverage: High
- Inspected evidence: Python/FastAPI 入口与路由、SQLAlchemy repository、React 状态与 API client、Tauri command、Rust auth/adapter/browser、数据库 schema、部署和 release workflow。
- Exclusions / limits: 未生成动态调用图，也没有在多实例、真实反向代理或四种桌面 OS 上观测运行拓扑。

| Finding | Impact on architecture |
|---------|------------------------|
| F-04 | async HTTP 边界之下仍是同步 DB I/O，运行模型与函数签名不一致 |
| F-11 | 一次设置更新跨多个 repository transaction，API 原子性没有唯一所有者 |
| F-17 | API、repository、认证与桌面同步核心模块过大，安全不变量散落在多个分支 |

已验证的优点：数据库持有服务端配置真相，Rust 持有桌面敏感状态，React 基本只持有视图状态；代理凭据不经过 IPC；direct 与 proxy 路径不会静默互相 fallback。整体分层方向正确，主要问题不是“没有架构”，而是事务、阻塞模型与生命周期契约没有被结构强制执行。

## 6. Security Analysis

- Coverage: High
- Inspected evidence: 全部路由的认证/授权装饰、JWT/密码/加密、登录失败计数、token 撤销、上传、CSRF/Origin、CSP、Tauri capability、本地 adapter、bypass/DNS、发布脚本和 npm audit。
- Exclusions / limits: 未做黑盒渗透、真实恶意 DNS/同机进程攻击；未接入 Python/Rust 实时漏洞库。

| Finding | Severity | Security consequence |
|---------|----------|----------------------|
| F-01 | High | 启动密钥 fail-open，可能造成已知密钥或多进程凭据不兼容 |
| F-02 | High | 防爆破、并发失败计数、会话上限和密码随机性未形成控制 |
| F-03 | High | 临时密码可直接访问桌面配置，不需要先改密 |
| F-06 | High | 并发操作可能破坏“至少一个超级管理员”不变量 |
| F-08 | High | 用户无法验证桌面安装包、Chromium 与构建来源 |
| F-13 | Medium | 公开孤儿上传和残留 profile 延长敏感数据暴露窗口 |
| F-14 | Medium | WebView、本机 socket 和私网直连权限面过宽 |

已确认的防线包括 Argon2 密码哈希、Fernet 静态加密、`token_version` 撤销、管理路由鉴权、cookie Origin 校验、上传路径/扩展名/大小检查、固定 CSP API origin、代理口令不跨 IPC，以及平台 URL/ID allowlist。没有发现硬编码真实凭据或 `dangerouslySetInnerHTML`。

## 7. Stability Analysis

- Coverage: High
- Inspected evidence: timeout、锁、事务边界、startup、health、Rust resource teardown、watchdog、前端错误状态及 158 项自动化测试。
- Exclusions / limits: 未进行长时间 soak、数据库断网/磁盘满/进程 kill 故障注入，Windows 与 Linux 条件分支未在对应实机运行。

主要问题为 F-04、F-05、F-06、F-09、F-10、F-11、F-12 和 F-15。它们共同说明正常路径已相当成熟，但异常路径仍有三类断点：资源清理依赖前一步成功、跨事务操作允许部分成功、错误/未知状态被吞掉或显示成正常。Rust 常规退出、proxy lease 和 browser child 的正常清理测试是明显优点，但还需把 cleanup 变成无条件 finally/guard 语义。

## 8. Performance Analysis

- Coverage: Medium
- Inspected evidence: FastAPI I/O 模型、SQL 查询/分页、桌面 HTTP body 读取、adapter accept/header 路径、前端 bundle 和资源加载。
- Exclusions / limits: 无真实 MySQL 数据规模、并发压测、CPU/内存 profile、浏览器 Performance trace 或四平台二进制体积数据。

| Concern | Evidence | Assessment |
|---------|----------|------------|
| Event-loop blocking | F-04 | 高影响；一次慢 DB 调用可阻塞同 worker 的其他 async 请求 |
| Resource amplification | F-12 | 中影响；连接、header、响应体和无分页列表缺硬上限 |
| Public product reads | `app.py` 产品配置聚合路径 | 单请求需要多次 DB round-trip，当前规模可用但可合并/缓存 |
| Web bundle | Web JS 约 497.64 kB，gzip 约 143.26 kB | 尚可；应把体积预算纳入 CI，而不是立即重写 |
| Desktop UI bundle | Desktop JS 约 233.12 kB，gzip 约 72.11 kB | 当前没有明显阻断 |

不应在没有 profile 的前提下做大规模优化。先修阻塞 I/O 和硬上限，再用生产量级数据测量慢查询、连接数与内存峰值。

## 9. Testing Analysis

- Coverage: High
- Inspected evidence: 52 个 Python、8 个 Web、12 个 Desktop Node、86 个 Rust 测试及对应源码；两套 Vite build 和桌面 surface boundary 检查。
- Exclusions / limits: 无真实 MySQL integration、浏览器 UI E2E、安装/升级/卸载、Nginx/systemd、备份恢复和多 worker 测试。

当前 158 项测试全部通过，且 Rust 测试覆盖 socket、并发、配置撤销和敏感边界，不是单纯占位测试。关键缺口是 F-03 的完整强制改密流程、F-05 的清理失败路径、F-06 的数据库并发不变量、F-07 的合并门禁，以及 F-16 的真实键盘/辅助技术行为。测试数量足以支撑重构，但不足以证明生产部署和安装包可靠。

## 10. Maintainability Analysis

- Coverage: High
- Inspected evidence: 全部一方源码、文件/函数规模、重复模式、ruff、mypy、rustfmt、clippy 快照结果及测试组织。
- Exclusions / limits: 未运行专用圈复杂度、依赖循环或提交热点工具。

F-11、F-15 和 F-17 是主要维护成本。`app.py`、`db.py`、Rust `auth.rs` 均超过 1,000 行，桌面同步命令约 207 行；这不是单纯审美问题，而是已经对应事务、cleanup 和状态分支遗漏。Python 当前有 35 个 ruff 问题和 9 个 mypy 错误；Rust clippy 在已提交快照上通过，`cargo fmt --check` 有格式差异。建议以行为测试为护栏按风险边界拆分，而非一次性重写。

## 11. Design / Principles Analysis

- Coverage: High
- Inspected evidence: 单一职责、状态所有权、最小权限、fail-fast、错误传播、事务、一致性与边界验证逐项对照。
- Exclusions / limits: 未访谈原作者，无法判断部分行为是明确产品取舍还是实现遗漏。

设计上最值得保留的是“敏感状态留在 Rust”“数据库是配置源”“代理失败不暗中直连”和“外部 URL/文件边界显式验证”。偏离原则的地方集中在 F-01/F-10 的 fail-open、F-02/F-14 的最小权限、F-04 的阻塞模型、F-05/F-09/F-15 的错误吞没，以及 F-11/F-17 的职责和事务分散。

## 12. Release Analysis

- Coverage: Medium
- Inspected evidence: GitHub Actions、Tauri 配置、Chromium 获取/打包脚本、版本标签策略、Linux systemd/Nginx/MySQL 文档和 release 说明。
- Exclusions / limits: 未实际构建、签名、安装或升级四平台产物；未验证 Apple/Windows 证书、GitHub environment 或生产回滚。

F-07 与 F-08 是发布级阻断。四目标 workflow 和文档说明已经形成发行骨架，但当前流程由 tag/手工触发，主线变更没有后端/Web/MySQL 门禁；macOS 未签名/公证且文档建议移除 quarantine，产物也缺 checksum、SBOM、provenance 和可验证 Chromium 来源。版本发布前还应让 readiness、迁移、备份恢复和上一版本升级成为自动验收。

## 13. Documentation Analysis

- Coverage: High
- Inspected evidence: `README.md`、`docs/` 下 Markdown、部署/备份/桌面发布说明、环境示例和代码契约。
- Exclusions / limits: DOCX 二进制未渲染核对；审计期间用户并发进行的 DOCX 重命名未纳入判断。

文档覆盖安装、部署、反代、备份恢复、桌面打包和使用流程，明显优于普通原型。但有两处“文档承诺强于实现”：临时密码必须修改的说法与 F-03 相反；浏览器 profile 清理的绝对表述没有覆盖崩溃后的启动清扫（F-13）。建议把安全/可靠性陈述写成可测试契约，并在 CI 中链接到对应测试。

## 14. Configuration Analysis

- Coverage: High
- Inspected evidence: 所有 `VESTUS_*` 配置读取、`.env.example`、Pydantic/启动校验、Tauri/Nginx/systemd、CSP 与平台/代理设置。
- Exclusions / limits: 未读取任何真实生产环境变量、证书、密钥管理器或基础设施配置。

F-01 是首要配置缺口：密钥缺失时自动生成进程内值，示例占位值也未拒绝。F-11 则表明动态品牌配置没有单事务更新。积极点是 API origin、平台 URL、上传和 bypass 输入有较严格解析。生产配置应有启动时 schema、熵/占位值检查、环境分层和安全的 secret rotation 说明。

## 15. Observability Analysis

- Coverage: High
- Inspected evidence: audit log、request ID、异常捕获、health/readiness、部署日志和前端健康展示。
- Exclusions / limits: 没有生产日志样本、指标后端、trace、告警规则、SLO 或 on-call 记录可检查。

F-09、F-10 和 F-15 使“系统实际状态”与“运营者看到的状态”可能不同：审计写失败被吞，readiness 只证明数据库可查询，前端 fetch 失败仍显示绿色。请求 ID 也没有稳定贯穿响应、日志和下游。最低目标应是结构化请求/actor/action/result 日志、可区分 liveness/readiness 的 HTTP 状态、关键错误计数与告警，以及 UI 的 unknown/degraded 状态。

## 16. Data Integrity Analysis

- Coverage: High
- Inspected evidence: SQL schema/约束、事务、并发锁、migration、删除、审计、备份恢复文档和并发测试。
- Exclusions / limits: 未在真实 MySQL 上并发执行迁移、互删、断电恢复或备份还原。

F-06、F-09、F-11 和 F-13 是数据一致性主线。最后超级管理员、业务动作与审计、品牌配置组合更新都缺数据库级原子边界；删除又没有覆盖相关 PII/文件的完整生命周期。建议把跨行不变量放入锁/事务或数据库约束，把审计和业务写同事务提交，并为 deletion/retention 建显式状态机和 reconciliation job。

## 17. Privacy / Data Governance Analysis

- Coverage: High
- Inspected evidence: 用户标识与登录日志、上传公开访问、代理密文、桌面 token/口令、Chromium profile、删除和备份说明。
- Exclusions / limits: 无正式隐私政策、数据处理清单、法定保留期、生产备份/对象存储策略。

F-13 是确认缺口：孤儿上传会继续公开，用户删除不等于日志中的用户名/IP/UA 清除，崩溃 profile 没有启动清扫。积极点是代理口令在服务端加密、桌面不向 React 暴露 token/代理口令、临时 profile 正常退出时会清理。应定义数据类别、所有者、公开性、保留期、删除触发和备份滞后，避免把“尽力清理”描述成保证。

## 18. Accessibility / UX Analysis

- Coverage: Medium
- Inspected evidence: Web/桌面登录、改密、对话框、toast、label、按钮、loading/error/empty 和键盘相关 JSX。
- Exclusions / limits: 未运行 axe、屏幕阅读器、全键盘遍历、200% 缩放、对比度或 reduced-motion 实机验收。

F-16 覆盖关键认证流的 label、键盘与 live-region 缺口；F-15 也会让错误状态的语义和颜色表达误导用户。UI 有一致组件基础和删除确认，但还没有把可访问名称、focus 顺序、错误关联、loading/unknown 与 toast 播报当作回归契约。

## 19. Supply Chain / Reproducibility Analysis

- Coverage: Medium
- Inspected evidence: npm/cargo lockfile、Actions pinning、Chromium 下载、`npx` 使用、artifact/release 步骤和本次 npm audit。
- Exclusions / limits: 无 SBOM、签名验证、Python/Rust advisory 扫描、离线全新机器复现或构建产物 bit-for-bit 对比。

两个 npm 安装审计均报告 0 个已知漏洞，Cargo 使用 lockfile 且可离线完成测试，这是良好基础。F-08 仍显示信任链缺口：`npx --yes playwright@1.62.1` 不在项目 lock 中、Chromium 选择依赖本机 cache mtime、Actions/下载物未全部 digest 固定、release 无 checksum/SBOM/provenance。依赖“版本号固定”不足以证明获取内容和最终产物一致。

## 20. Cost Analysis

- Coverage: Medium
- Inspected evidence: DB round-trip、登录失败日志、上传/审计增长、adapter 连接/task、HTTP body 和列表数据量。
- Exclusions / limits: 无生产流量、存储、备份、带宽、数据库规格或云账单；项目没有模型/token 成本。

当前没有复杂基础设施或 AI 成本失控信号。成本风险主要是无界增长与放大：F-02 的失败日志、F-12 的连接/响应/列表、F-13 的上传和日志保留，以及公开产品配置的多次 DB 查询。先设置容量上限、分页、保留期和最小指标，再根据实测决定缓存或扩容。

## 21. AI / LLM Safety Analysis

- Coverage: Not assessed
- Inspected evidence: 对源码、依赖、配置和文档搜索模型、prompt、RAG、embedding、agent、tool-call 与内容生成运行面。
- Exclusions / limits: 未发现可审计的 AI/LLM 功能；名称中的泛化关键词不构成模型集成证据。

本维度对当前 Vestus 不适用。系统没有 LLM 输入输出、工具调用、向量库或模型凭据，因此不存在 prompt injection、模型数据外泄或 token 成本结论。将来若引入 AI 功能，应作为新 trust boundary 重新审计，不能沿用本次“不适用”。

## 22. Fallback Analysis

- Coverage: High
- Inspected evidence: 密钥 fallback、startup/health、catch/pass、前端默认状态、代理/direct 选择、浏览器和同步错误路径。
- Exclusions / limits: 未对所有下游依赖执行系统化 chaos testing。

F-01、F-10 与 F-15 都是危险 fallback：用临时密钥继续运行、初始化失败仍可 ready、health 失败仍显示正常。与之相反，代理不可用时不会静默改为 direct 是正确且应保留的行为。原则应统一为：安全/一致性前提不成立就显式失败；纯展示能力才允许带清楚标记的降级。

## 23. Testing Authenticity Analysis

- Coverage: High
- Inspected evidence: 测试是否调用真实 FastAPI app、文件系统、socket、并发原语和 Rust 状态机，以及是否只做字符串/实现细节断言。
- Exclusions / limits: UI 测试没有真实浏览器；数据库测试未使用生产 MySQL；安装/发布检查未运行真实产物。

大部分后端/Rust 测试执行真实业务路径，能发现回归；本次 Rust 测试在沙箱中因 loopback 权限出现 11 个假失败，移出受限网络沙箱后 86 项全部通过，也说明环境差异需要被准确解释。F-03、F-05、F-06 和 F-07 对应的端到端/生产边界仍空缺；surface boundary 中基于源码字符串的检查有价值，但不能替代编译期架构约束或运行测试。

## 24. Type Safety Analysis

- Coverage: High
- Inspected evidence: TypeScript strict 配置、外部 JSON cast/`any`、Python annotations/mypy、Rust unsafe/unwrap 与 DTO 边界。
- Exclusions / limits: 未运行 pyright，也没有针对所有 HTTP JSON 的统一 runtime schema 工具。

Rust 和两套 TypeScript 都有较强静态基础，但 F-17 指出真实边界仍通过 `any`、`as T`、动态 `Dict[str, Any]` 和静默默认值穿透。mypy 当前报告 9 个错误。优先把认证 claims、桌面配置和管理 DTO 变成可运行验证的 schema；类型断言只应出现在已验证的数据之后。

## 25. Frontend State Analysis

- Coverage: High
- Inspected evidence: 两套 React App、AuthProvider、API client、effects/loaders、健康状态、表单、toast 和权限导航。
- Exclusions / limits: 未在真实浏览器触发快速输入、网络乱序、会话过期、刷新恢复或辅助技术流程。

F-03 表明后端状态 `must_change_password` 没有驱动桌面视图；F-15 表明 401、health reject 和请求 revision 没有进入显式状态机；F-16 则影响认证反馈。状态所有权总体简单，但需要统一建模 `idle/loading/success/empty/error/expired/unknown`，避免由默认值和旧 Promise 暗中决定 UI。

## 26. Backend API Analysis

- Coverage: High
- Inspected evidence: 全部 56 个路由声明、request/response model、认证/授权、状态码、分页、事务、startup 与 health。
- Exclusions / limits: 未做 OpenAPI breaking-change diff、真实 Nginx/header 行为、生产 MySQL/多 worker 或外部客户端兼容测试。

API 的路由保护和输入验证整体存在，但 F-01/F-02/F-03 破坏认证策略，F-04 破坏 async 运行模型，F-06/F-09/F-11 破坏一致性，F-10 破坏可路由性信号，F-12 破坏资源边界。另有低优先级契约瑕疵：非法日期查询会变成 500，部分更新模型默认忽略额外字段。建议以服务层事务、统一错误 envelope、分页/上限和 OpenAPI contract test 收敛。

## 27. Dependency Weight Analysis

- Coverage: Medium
- Inspected evidence: 直接依赖与 import 使用、npm/cargo lockfile、构建 bundle、Rust dependency tree 和 Playwright/Chromium 获取路径。
- Exclusions / limits: 未运行 bundle analyzer、license scanner、跨版本 tree diff 或四平台安装体积比较。

前端 bundle 尚未显示需要框架级重写；Web 有约 5 个未见使用的 Radix 直接依赖，可作为低风险清理项。更重要的是 F-08 中游离于 lockfile 的 `npx` 和 Chromium cache 选择。删除依赖前应先以 `rg`、build 与测试确认，发布依赖则应锁 digest 并记录 provenance。

## 28. Code Consistency Analysis

- Coverage: High
- Inspected evidence: ruff、mypy、rustfmt、clippy 快照、命名、错误传播、配置读取和前端模式搜索。
- Exclusions / limits: TypeScript 没有统一 ESLint 配置；未审计历史提交的格式噪声。

测试/build 全绿不等于静态质量门禁全绿：ruff 有 35 项，mypy 有 9 项，`cargo fmt --check` 有差异；Rust clippy 在审计基线通过。F-17 反映更深层的不一致是 Python 动态字典和 TypeScript 强转与 Rust 严格边界并存。建议先统一自动格式和静态检查，再逐步收紧类型，不要一次性格式化混入安全修复。

## 29. Comment Coverage Analysis

- Coverage: Medium
- Inspected evidence: README/docs、Python/Rust 模块和公开 API 注释、TODO/FIXME/HACK、关键安全分支说明。
- Exclusions / limits: 没有要求简单 getter、DTO 或显然代码逐行注释，也未做自动文档覆盖率统计。

高层说明和关键 Rust 安全边界注释整体充分，未发现大规模 TODO 债务。问题在于少量绝对性说明已与行为漂移：强制改密（F-03）和 profile 清理（F-13）。注释重点应放在“为什么存在这个不变量、失败时必须怎样”，并由测试引用；无需通过增加重复代码含义的注释来追求数量。

## 30. Principles Compliance

### Confirmed violations

| Principle | Findings | Evidence-backed assessment |
|-----------|----------|----------------------------|
| SRP / file and function size（1.1–1.3） | F-17 | 多个 1,000 行核心模块和 207 行同步函数聚合多类职责 |
| Fail Fast（4.4） | F-01, F-03, F-06, F-10 | 安全配置、强制改密、不变量和 readiness 前提不成立时仍继续 |
| Least Privilege（4.6） | F-02, F-08, F-13, F-14 | 会话/本机权限/公开数据/发行信任边界宽于必要范围 |
| Avoid blocking async（10.1） | F-04 | async FastAPI 路径直接调用同步 SQLAlchemy |
| Resource bounds（10.2） | F-02, F-12, F-13 | 尝试日志、连接、body、列表和数据保留存在无界面 |
| Don’t Swallow Errors（6.1） | F-05, F-09, F-13, F-15 | cleanup、审计、profile 和 UI 错误没有可靠暴露或补偿 |
| Race-safe invariants（5.4） | F-06 | count-then-delete 没有锁住同一管理集合 |
| Transactional integrity（5.3） | F-09, F-11 | 逻辑上的一次操作跨事务并允许部分提交 |

### Respected principles

- 敏感 token 与代理口令留在 Rust，不暴露给 React IPC。
- direct 与 proxy 选择显式，代理失败不静默绕过安全策略。
- 上传路径、文件类型/大小、平台 URL/ID、bypass 输入都有明确验证。
- Rust 对正常 adapter/browser 生命周期有集中所有权和相当扎实的并发测试。
- 数据库、Rust 核心与 React 视图的状态所有权大体清楚，没有重复维护代理凭据。

## 31. Recommended Fix Order

### Immediate — 当前稳定发布阻断

1. **F-01：让启动密钥 fail closed。** 生产环境缺失、过短、低熵或等于示例占位值时拒绝启动；提供明确轮换/多 worker 契约。
2. **F-03：真正执行临时密码强制改密。** reset 写入 true，token 带状态，后端只允许改密/登出，桌面渲染现有改密组件。
3. **F-05：把桌面 teardown 放进无条件清理路径。** 远端操作、keyring、adapter、watchdog、browser cleanup 分别记录结果，确保资源最终回收。
4. **F-08：停止把移除 quarantine 当安装方案。** macOS 签名/公证、产物 checksum、SBOM/provenance、Chromium digest 与 Actions pinning 必须进入发行链。
5. **F-06：数据库级守住最后超级管理员。** 用事务锁/串行化策略实现，并在真实 MySQL 做并发互删测试。

### Before stable release

1. **F-02：** 为管理员和用户统一原子 rate limit/lockout；执行 `maxSessions`；密码改用 CSPRNG。
2. **F-04：** 改用 sync route/threadpool 或异步 DB stack，并压测慢查询下的并发请求。
3. **F-07：** push/PR 上运行 Python、Web、Desktop、Rust、lint/typecheck 和真实 MySQL migration smoke。
4. **F-09/F-11：** 把业务写、审计和组合设置更新收进单一 transaction/service boundary。
5. **F-10：** readiness 检查 schema/migration/关键配置，失败返回 503；liveness 独立。
6. **F-12/F-14：** 添加连接/header/body/list 硬上限，并收窄 Tauri、本机 socket 与私网 bypass 权限。

### Later hardening

1. **F-13：** 数据分类、保留/删除、孤儿上传回收、profile 启动清扫和 reconciliation。
2. **F-15：** 前端统一 expired/unknown/error/revision 状态模型。
3. **F-16：** 认证流的 label、键盘、focus、live region 与 axe 回归。
4. **F-17：** 在行为测试护栏下拆分巨型模块，修完 mypy 并给外部响应加 runtime schema。

### Safe to defer

- 未使用的少量 Radix 依赖、直接 IP 展示回退、纯格式差异和部分注释改进，不应抢占上述安全/一致性工作。
- 在没有负载 profile 之前，不建议进行缓存体系、前端框架或数据库层的大规模替换。

## 32. Quick Wins

| Action | Expected value | Effort |
|--------|----------------|--------|
| 启动时拒绝缺失/占位/低熵密钥 | 立即消除最危险的配置 fail-open | 2–4 小时 |
| 把现有 `ChangePasswordCard` 接入 auth 状态 | 恢复用户可见的强制改密入口 | 2–4 小时，另需后端执法 |
| readiness 失败返回 503，并让前端显示 unknown | 避免编排器和管理员被绿色假象误导 | 2–4 小时 |
| 密码生成从 `Math.random` 改为 Web Crypto/CSPRNG | 消除弱随机凭据 | 1 小时 |
| API 401 统一触发 auth-expired | 避免旧壳层和敏感数据继续显示 | 2–4 小时 |
| 移除 `core:default`，列出实际需要的 capability | 收窄 WebView 攻击面 | 2–4 小时加回归测试 |
| 对桌面 HTTP response 先检查长度并流式计数 | 避免限额前完整缓冲 | 4–8 小时 |
| 应用 rustfmt，修 9 个 mypy 错误 | 让静态门禁可落地 | 4–8 小时，单独提交 |

## 33. Long-term Refactor Plan

### Phase 1 — 配置与运行健康契约

- Motivation: F-01/F-10 让进程“启动”与“可安全服务”混为一谈。
- Approach: 建立单一 typed settings schema、环境级校验、secret provider/rotation 契约，以及分离的 liveness/readiness/diagnostics。
- Main risk: 直接 fail closed 会暴露现有部署遗漏；需先提供升级检查命令和回滚说明。
- Verification: 配置矩阵测试、占位密钥拒绝、多 worker token 互认、migration mismatch 返回 503。

### Phase 2 — 账号与会话服务

- Motivation: F-02/F-03/F-06 的策略分散在 route、repository 和客户端。
- Approach: 引入 AccountPolicyService，集中 lockout、session registry、must-change 状态和超级管理员不变量；所有端只消费同一状态机。
- Main risk: 旧 token 和已有用户迁移语义变化。
- Verification: 并发失败计数、会话上限、reset→受限 token→改密→重签、真实 MySQL 互删测试。

### Phase 3 — 原子写入与可靠审计

- Motivation: F-09/F-11 允许成功操作缺审计或组合配置半提交。
- Approach: service 取得 transaction ownership，repository 不自行 commit；必要时用 transactional outbox 将外部日志投递与业务事实解耦。
- Main risk: 事务范围扩大可能提高锁竞争。
- Verification: 每个写入阶段注入异常，断言全回滚或有可重放 outbox；监控事务延迟和 deadlock。

### Phase 4 — 拆分核心模块与生命周期对象

- Motivation: F-05/F-17 显示 cleanup、网络、认证和同步职责已难以一起推理。
- Approach: Python 拆 routes/services/repositories/models；Rust 拆 AuthHttpClient、CredentialSession、DesktopSyncTransaction、BrowserLease，并用 guard/Drop/finally 表达清理。
- Main risk: 大拆分容易产生行为漂移。
- Verification: 先补 characterisation tests；每次只移动一个边界；保持 158 项现有测试与新增故障注入持续通过。

### Phase 5 — 可验证发行与持续交付

- Motivation: F-07/F-08 使源码测试与用户拿到的二进制之间缺证据链。
- Approach: PR CI matrix + MySQL service；digest 固定依赖；生成 SBOM、checksum、签名/provenance；macOS notarization；安装、升级、启动和回滚 smoke。
- Main risk: 证书、缓存和跨平台 runner 会增加维护成本与发布时长。
- Verification: 干净 runner 可复现构建；签名、公证和 checksum 自动验证；上一稳定版原地升级后完成登录、同步、代理和卸载 smoke。

---

**Final verdict:** Vestus 现在是“功能闭环较完整、工程基础良好、但发布保障尚未闭环”的候选版本。与初始/记忆基线相比，产品能力已经大幅补齐；与稳定公开发布标准相比，仍应先关闭 F-01、F-03、F-05、F-06、F-08，并完成真实 MySQL 与安装包门禁。完成这些项目后，再重新执行本报告中的 158 项测试、静态检查、四平台构建和生产边界验收。
