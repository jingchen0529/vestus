# Vestus Python 后台管理系统建设建议（首期）

> 历史提案：本文是只使用三张表的首期建议，现已被代理/平台集中分配实现取代。当前数据库共使用七张业务表，接口与部署方式以 [README.md](README.md) 为准。

## 1. 本次范围

首期只建设一个 Python Web 后台和桌面端登录接口，数据库只使用以下三张表：

| 表名 | 用途 |
|---|---|
| admin | 后台管理员账号 |
| user | 桌面端用户账号 |
| user_log | 管理员和桌面端用户的登录、账号管理及关键操作日志 |

本阶段不新增其他业务表、会话表、角色表、设备表或配置表。后续确有需要时再通过数据库迁移增加。

首期功能：

1. 管理员登录、退出和后台访问控制
2. 管理员账号的新增、编辑、启用、停用和重置密码
3. 桌面端用户的新增、编辑、启用、停用和重置密码
4. 桌面端用户登录后才能访问受保护接口
5. 用户日志查询、筛选和分页

首期不包含注册、短信验证码、第三方登录、计费、复杂组织架构和具体广告业务数据持久化。

## 2. 当前项目情况

仓库已有 app.py、db.py 等 FastAPI + SQLite 原型，桌面端认证目前主要依赖 localStorage。它们只能作为界面和接口参考，不能继续作为正式认证和数据存储方案。

后续实现建议继续使用：

- Python 3.12
- FastAPI
- SQLAlchemy 2.x
- Alembic
- MySQL 8.0/8.4、InnoDB、utf8mb4
- Pydantic v2
- Argon2id 密码哈希

所有时间在数据库中统一使用 UTC 的 DATETIME(6)，后台页面按 Asia/Shanghai 展示。

## 3. 认证方案（只依赖三张表）

由于首期不建立独立 session 表，认证采用短期签名令牌：

- 管理后台登录成功后返回 HttpOnly Cookie。
- 桌面端登录成功后返回短期 Bearer Access Token。
- 令牌内包含账号类型、账号 ID、签发时间、过期时间和 token_version。
- admin 和 user 表都保存 token_version；每次请求除了验证令牌签名，还要查询数据库确认账号状态、有效期和版本号。
- 停用账号、重置密码或强制退出时递增 token_version，旧令牌立即失效。
- 首期不支持多设备独立会话和单个设备会话撤销；这些能力后续增加 session 表时再实现。

令牌建议：

- Access Token 有效期 10 至 15 分钟。
- 管理后台 Cookie 设置 HttpOnly、Secure、SameSite=Lax。
- 管理后台所有写操作启用 CSRF 校验。
- Tauri 桌面端令牌保存到系统 Keychain/Stronghold，不保存到 localStorage。
- 每个受保护接口都重新检查账号是否 active、是否到期，不能只信任令牌中的旧状态。

## 4. 三张表设计

### 4.1 admin：管理员表

表名按需求固定为 admin。SQL 查询中建议使用反引号引用，避免与数据库关键字或函数产生歧义。

~~~text
id                    BIGINT UNSIGNED PRIMARY KEY
username              VARCHAR(64) UNIQUE NOT NULL
password_hash         VARCHAR(255) NOT NULL
name                  VARCHAR(100) NOT NULL
role                  VARCHAR(32) NOT NULL DEFAULT 'admin'
status                VARCHAR(16) NOT NULL DEFAULT 'active'
token_version         INT UNSIGNED NOT NULL DEFAULT 1
last_login_at         DATETIME(6) NULL
last_login_ip         VARBINARY(16) NULL
password_changed_at   DATETIME(6) NULL
created_at            DATETIME(6) NOT NULL
updated_at            DATETIME(6) NOT NULL
deleted_at            DATETIME(6) NULL
~~~

首期角色只保留两个值即可：

- super_admin：全部后台权限
- admin：管理员登录、桌面端用户管理和日志查看

暂不建立角色关联表。最后一个有效 super_admin 不允许被停用或降级，检查和更新必须在同一事务中完成。

### 4.2 user：桌面端用户表

表名按需求固定为 user。建议同样在 SQL 中使用反引号。

~~~text
id                    BIGINT UNSIGNED PRIMARY KEY
username              VARCHAR(64) UNIQUE NOT NULL
password_hash         VARCHAR(255) NOT NULL
name                  VARCHAR(100) NOT NULL
company               VARCHAR(200) NULL
phone                 VARCHAR(32) NULL
status                VARCHAR(16) NOT NULL DEFAULT 'active'
expires_at            DATETIME(6) NULL
max_sessions          SMALLINT UNSIGNED NOT NULL DEFAULT 1
token_version         INT UNSIGNED NOT NULL DEFAULT 1
failed_login_count    SMALLINT UNSIGNED NOT NULL DEFAULT 0
locked_until          DATETIME(6) NULL
must_change_password  TINYINT(1) NOT NULL DEFAULT 0
last_login_at         DATETIME(6) NULL
last_login_ip         VARBINARY(16) NULL
created_by            BIGINT UNSIGNED NULL
remark                VARCHAR(500) NULL
created_at            DATETIME(6) NOT NULL
updated_at            DATETIME(6) NOT NULL
deleted_at            DATETIME(6) NULL
~~~

status 首期取值为 active、disabled、locked。账号有效期使用排他上界判断：只有在 expires_at 为空或当前 UTC 时间小于 expires_at 时才允许登录和访问。删除采用软删除，避免历史日志丢失主体。

建议索引：

- UNIQUE(username)
- INDEX(status, expires_at)
- INDEX(created_at, id)

### 4.3 user_log：用户日志表

该表同时记录管理员和桌面端用户行为，日志由服务端生成，客户端不能传入可信的操作人、角色、IP 或结果。

~~~text
id                    BIGINT UNSIGNED PRIMARY KEY
request_id            CHAR(36) NULL
actor_type            VARCHAR(16) NOT NULL
actor_id              BIGINT UNSIGNED NULL
actor_username        VARCHAR(64) NULL
actor_role            VARCHAR(32) NULL
action                VARCHAR(64) NOT NULL
target_type           VARCHAR(16) NULL
target_id             BIGINT UNSIGNED NULL
target_name           VARCHAR(100) NULL
summary               VARCHAR(500) NOT NULL
ip_address            VARBINARY(16) NULL
user_agent            VARCHAR(512) NULL
status                VARCHAR(16) NOT NULL
details               JSON NULL
created_at            DATETIME(6) NOT NULL
~~~

actor_type 取值为 admin、user、system，status 取值为 SUCCESS、FAILED。建议索引：

- INDEX(created_at, id)
- INDEX(actor_type, actor_id, created_at)
- INDEX(action, created_at)
- INDEX(status, created_at)

日志禁止保存密码、完整 Access Token、Cookie、代理密码、应用密钥和完整请求体。日志只追加，不提供普通修改和删除接口。

## 5. 后台功能与接口草案

### 5.1 后台认证

~~~text
POST /api/admin/auth/login
POST /api/admin/auth/logout
GET  /api/admin/auth/me
~~~

### 5.2 管理员管理

~~~text
GET    /api/admin/admins
POST   /api/admin/admins
GET    /api/admin/admins/{id}
PATCH  /api/admin/admins/{id}
POST   /api/admin/admins/{id}/enable
POST   /api/admin/admins/{id}/disable
POST   /api/admin/admins/{id}/reset-password
~~~

上述接口均要求管理员登录，并按 role 做服务端权限校验。

### 5.3 桌面端用户管理

~~~text
GET    /api/admin/users
POST   /api/admin/users
GET    /api/admin/users/{id}
PATCH  /api/admin/users/{id}
POST   /api/admin/users/{id}/enable
POST   /api/admin/users/{id}/disable
POST   /api/admin/users/{id}/reset-password
~~~

### 5.4 桌面端认证

~~~text
POST /api/user/auth/login
POST /api/user/auth/logout
GET  /api/user/auth/me
POST /api/user/auth/change-password
~~~

除登录接口外，所有桌面端业务接口默认要求有效用户令牌。管理员令牌不能调用桌面端用户业务接口，桌面端用户令牌也不能调用后台管理接口。

### 5.5 用户日志

~~~text
GET /api/admin/user-logs
GET /api/admin/user-logs/{id}
GET /api/admin/user-logs/export
~~~

日志列表支持按操作人、动作、状态、目标账号和时间范围筛选，并采用分页或游标方式返回。日志导出动作本身也写入 user_log。

## 6. 首期安全要求

- 密码使用 Argon2id 哈希，数据库和接口都不出现明文密码。
- 不在生产环境内置 admin/admin888、client/123456 等演示凭据。
- 登录失败对外返回统一错误提示，详细原因只写入日志。
- 按账号和 IP 做基础限流，连续失败后临时锁定用户。
- 生产环境使用 HTTPS；后台 Cookie 开启 Secure、HttpOnly 和 SameSite。
- 只在明确配置可信反向代理时读取 X-Forwarded-For。
- 重置密码、停用账号和角色变更时递增 token_version，使旧令牌失效。
- 审计日志不允许前端自行伪造；操作人、IP、User-Agent 由服务端上下文生成。
- MySQL 运行账号不授予 DDL 权限，Alembic 使用独立迁移账号。

## 7. 现有桌面端的后续接入点

实现阶段需要：

1. 将 desktop/src/services/authService.ts 的 localStorage 登录和用户数据改为调用上述 API。
2. 删除生产环境的快捷演示账号按钮和前端明文密码。
3. 清理旧的 vestus_users_list_v1、vestus_current_session_v1、vestus_audit_logs_v1 数据，防止绕过服务端认证。
4. 管理页面的用户管理和日志页面改为服务端查询，不再把前端数组作为数据源。
5. Tauri 打开浏览器、代理测试等敏感动作执行前检查有效桌面令牌。
6. 代理、广告授权和改价等关键动作由后端业务接口统一写入 user_log。
7. oceanEngineService.ts 目前仍使用本地数据，后续业务接口必须按 user_id 隔离；这不纳入本阶段实现。

## 8. 实施顺序

### 第一阶段：三张表和认证

- 创建 MySQL 数据库及 Alembic 初始迁移
- 实现 admin、user、user_log 模型
- 实现管理员登录和桌面端登录
- 实现状态、有效期和 token_version 校验

### 第二阶段：后台管理

- 管理员 CRUD、启停和重置密码
- 桌面端用户 CRUD、启停和重置密码
- 日志查询、筛选、分页和导出
- 所有管理操作写入 user_log

### 第三阶段：桌面端接入

- 替换前端本地认证
- 接入 Tauri 安全存储
- 保护关键 IPC 和业务调用
- 编写认证、越权、停用、过期和令牌失效测试

## 9. 验收标准

- 未登录用户不能进入后台，也不能调用受保护的桌面端接口。
- 普通桌面端用户调用后台管理接口返回 403。
- 管理员可以新增、编辑、启用、停用和重置桌面端用户。
- 最后一个有效超级管理员不能被停用或降级。
- 用户停用、过期、锁定或令牌版本变化后，旧令牌不能继续使用。
- 管理员和桌面端用户的关键操作均写入 user_log。
- 日志支持筛选和分页，且不包含密码和完整令牌。
- 服务重启后，三张表中的数据仍保存在 MySQL。
- 全新数据库可以通过迁移脚本初始化，核心认证和权限流程有自动化测试。

## 10. 本阶段明确不做的表

以下内容后期按实际需要再增加，本阶段不创建：

- 独立 session/refresh token 表
- 角色和权限关联表
- 设备绑定表
- 代理配置表
- 广告账户、广告计划和业务数据表
- 系统设置表
