# Vestus Python Web 后台

## 入口边界

- Web 管理后台：访问 `/admin`，只允许 `admin` 表中的管理员登录。页面源码是 `web/admin.html`，
  由后端直接返回。
- Tauri/Rust 桌面客户端：只允许 `user` 表中的桌面端用户登录，源码在 `desktop/`。
- Vite 页面属于桌面客户端资源，不是 Web 管理后台；普通浏览器打开时只提示使用 Tauri
  客户端，管理员后台始终使用独立的 `/admin` 入口。

两个入口分别调用 `/api/admin/auth/*` 和 `/api/user/auth/*`，不会自动尝试或切换另一类账号。

后台使用 MySQL 中的账号、审计和桌面配置表：

- `admin`：后台管理员
- `user`：桌面端用户
- `user_log`：管理员和桌面端用户操作日志
- `proxy` / `platform`：管理员维护的代理节点和平台入口；所有 active 平台下发给全部桌面用户，代理按用户解析（单独指派 → 默认节点 → 第一条启用节点）
- `user_proxy_assignment` / `user_platform_assignment`：历史用户配置关联表，仅为兼容保留，桌面配置读取不再使用
- `system_setting`：产品名称、Logo 与界面颜色配置
- `uploaded_file`：上传文件元数据（只保存相对路径）

代码使用 FastAPI + SQLAlchemy + PyMySQL，全部放在仓库根目录的 `app/` 包里，按
`api → services → repositories → db` 单向分层：路由只做 HTTP 解析与鉴权，事务边界（`commit`）
只属于 `app/services/`，`app/repositories/` 只查询。分层规则写在 [.importlinter](../.importlinter)，
`lint-imports` 可直接校验。MySQL 是默认数据库；不会创建旧版 `users`、`sessions` 或 `audit_logs` 表。

表结构由 Alembic 管理（见下文「数据库迁移」），`python3 scripts/init_db.py` 会自动判断该建表、
接管还是升级，并引导首个管理员。

## 启动

在仓库根目录执行：

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
python3 scripts/init_db.py
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

`VESTUS_SECRET_KEY` 不再有进程内随机兜底：没设置、仍是 `.env.example` 里的占位值、长度不足 32
字符或字符种类过少时，进程在启动阶段就直接退出并说明原因。

推荐设置：

```bash
export VESTUS_DATABASE_URL='mysql+pymysql://vestus:password@127.0.0.1:3306/vestus?charset=utf8mb4'
export VESTUS_SECRET_KEY='至少 32 字节的随机密钥'
export VESTUS_PROXY_SECRET_KEY='用于 Fernet 加密代理密码的稳定随机密钥'
export VESTUS_PRODUCT_NAME='桌面客户端显示的产品名称'
export VESTUS_BOOTSTRAP_ADMIN_USERNAME='admin'
export VESTUS_BOOTSTRAP_ADMIN_PASSWORD='首次部署时设置的强密码'
export VESTUS_UPLOAD_DIR='/var/lib/vestus/uploads'
export VESTUS_UPLOAD_MAX_BYTES='10485760'
```

没有可用 MySQL 时，测试可以显式指定 SQLite（不会改变生产默认）：

```bash
VESTUS_DATABASE_URL='sqlite:////tmp/vestus-test.db' uvicorn app.main:app
```

## 接口概览

- 管理员认证：`POST/GET /api/admin/auth/login|me`，`POST /api/admin/auth/logout`
- 管理员管理：`/api/admin/admins`
- 桌面端用户认证：`POST/GET /api/user/auth/login|me`，`POST /api/user/auth/logout|change-password`
- 桌面端用户管理：`/api/admin/users`
- 代理和平台管理：`/api/admin/proxies`、`/api/admin/platforms`
- 全局桌面配置：桌面端 `/api/user/desktop-config`；已废弃的管理员 `/api/admin/users/{id}/desktop-config` 按用户接口统一返回 HTTP 410
- 配置存续校验：桌面端 `GET /api/user/desktop-config/lease`
- 产品名称：登录前公开读取 `GET /api/product`
- 网络出口探测：登录前公开读取 `GET /api/network/ip`
- 日志分页：`GET /api/admin/user-logs`
- 通用文件上传：管理员 `POST /api/admin/uploads`（multipart 字段 `file`），公开读取
  `GET /uploads/{file_path}`

桌面端登录后由 Rust 持有 `access_token` 并作为 `Authorization: Bearer <token>` 发送，令牌
不会进入 React/JavaScript。Web 管理端把登录响应中的令牌只保存在页面内存，同时用 HttpOnly
Cookie 支持刷新后的会话恢复；Cookie 认证的写请求还必须通过同源 `Origin` 校验。令牌有效期和
账号表中的 `token_version` 会在每次请求校验；停用、重置密码、退出登录后旧令牌立即失效。桌面端还会
定期校验配置 lease；管理员变更、停用或替换全局代理/平台后，所有受影响桌面端的旧代理和浏览器会被关闭。

`GET /api/network/ip` 只返回 Vestus API 观察到的当前请求来源 IP，并设置
`Cache-Control: no-store`。桌面端直连请求时得到本机公网出口 IP，通过已配置上游代理请求时得到
代理出口 IP；客户端也据此验证所选路径能否到达自己的 Vestus 服务，不依赖第三方 IP 服务。反向代理
必须覆盖传入的 `X-Forwarded-For`；应用只读取 ASGI 已验证的 `request.client`，不直接信任该请求头。

## 桌面端配置与管理员可见范围

`platform.status = 'active'` 的全部平台会下发给每个桌面用户。代理按用户解析，`/api/user/desktop-config`
（及其 lease）里的那条节点依次取：

1. 用户被单独指定的 `user.proxy_id`，前提是这条代理仍然 `active`；
2. `proxy.is_default = true` 且 `active` 的那条（全局最多一条默认）；
3. 按 `id` 升序的第一条 `active` 代理。

第 3 步按 `id` 而不是 `updated_at` 排序：编辑任意代理都会刷新它的 `updated_at`，用"最近更新"做兜底
会让每次无关编辑都把未指派用户整体搬一次家。允许一条 `active` 代理都没有，客户端此时使用保留的
直连模式开关。

默认标记只能是启用状态：把默认节点改成 `disabled` 会同时摘掉它的默认标记（审计行摘要写明"已取消其
默认标记"），而一次请求里同时提交"停用 + 设为默认"会被 400 拒绝。指定到已停用节点的用户在列表里会
显示 `proxyActive: false`，提示这条指派已失效、实际走的是默认节点。

`is_default` 是全局唯一的：两条写入路径（创建、更新）都要先更新 `system_setting` 中的内部单例锁行
再读任何代理行，这样即使当前没有默认，并发设置默认也会串行执行，不会留下两条。锁先于 SELECT 的
顺序由 `test_proxy_default_locks_singleton_before_target_row` 断言。

`user.proxy_id` / `user.bound_admin_id` 都没有数据库外键，引用清理由服务层负责：删除代理时清空指向它
的 `user.proxy_id`，删除管理员时清空指向它的 `user.bound_admin_id`（否则那些账号会绑定在一个已删除
的行上，任何编辑都会以"管理员不存在"失败）。

管理员的数据可见范围由 `user.bound_admin_id` 决定。普通管理员（`role=admin`）只能看到绑定给自己的
桌面用户：`/api/admin/users`、`/api/admin/stats`、`/api/admin/browser-sessions`（含详情）、advid 导出和
`/api/admin/user-logs`（含详情）都按这个范围过滤，越界一律 404；`bound_admin_id` 与 `proxy_id` 这两个
字段只有超级管理员可以写，普通管理员提交它们会得到 403（`code=40301`），它们自己创建的用户会自动
绑定到自己名下。审计日志的过滤规则是"自己的操作 + 名下用户产生的行 + 针对名下用户的行"，因为其他
租户的用户名、IP 和会话 id 正是绑定关系要隔离的内容。

代理节点的写操作（创建 / 修改 / 删除，含默认标记）以及平台、系统配置、管理员管理都只开放给超级
管理员；代理列表读取对所有管理员开放，返回内容不含口令。

`user_proxy_assignment` 和 `user_platform_assignment` 是 legacy compatibility 表，可以继续存在；当前 HTTP API
不再写入或读取它们，它们也不会参与 `/api/user/desktop-config` 或 lease 计算。升级已有数据库时，
建议先备份。服务启动时若发现多条默认代理（历史数据或备份恢复可能造成），会自动保留 `updated_at`
最新的一条；时间相同时保留 `id` 最大的一条，其余清掉 `is_default`。代理的 `status` 不再被启动过程
改写。assignment 表中的历史数据不会被该过程删除或改写。

生产环境必须固定设置 `VESTUS_SECRET_KEY` 与 `VESTUS_PROXY_SECRET_KEY`；代理密码下发链路必须使用
HTTPS，桌面端需在构建时设置 `VESTUS_API_BASE_URL=https://...`。同时建议启用 Secure Cookie 和
可信反向代理配置。更换代理加密密钥前，需要先制定已有密文的迁移方案，否则旧代理密码将无法
解密。代理密码下发到桌面端后只保留在当前 Rust 会话内存，不会写入本地 JSON 或系统密钥链。

## 设备标识

桌面端在登录请求（`deviceId`）和每批活动上报（`deviceId`）里携带操作系统暴露的机器标识：
macOS 读 `IOPlatformUUID`（`ioreg -rd1 -c IOPlatformExpertDevice`），Windows 读注册表
`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`（`winreg`），Linux 读 `/etc/machine-id`，
回退 `/var/lib/dbus/machine-id`。读取在进程内只做一次并缓存，登录与每次上报共用同一个值。

服务端归一化只做三件事：去空白、去大括号、转小写（`app/core/device.py`）。三平台格式本来就不同
——macOS 是大写 UUID、Windows 是小写十六进制且常带大括号、Linux 是 32 位小写十六进制——同一台
机器永远只报它自己平台那一种，所以不需要把 UUID 的横线也抹掉。**归一化永不抛错**：不是字符串、
为空、超过 64 字符、或含十六进制与连字符之外的字符，一律丢弃为 `None` 并照常完成登录/上报。
这条规则的目的是「采集设备码绝不能成为登录失败的原因」——注册表被组策略锁定、容器里没有
machine-id 的机器都必须能正常使用。

存储与展示：`user.last_device_id` 记录最近一次登录上报的值（**不带该字段的登录不会清空它**，
以免老客户端抹掉已知设备），`browser_session.device_id` 每个会话存一份（后续批次只会填补空值，
不会改写已有值，避免伪造上报给会话换标签）。登录成功那条审计日志也会把设备码写进 `details`。
管理端在用户列表「最近设备」与会话追踪「设备码」两列展示，可见范围沿用绑定关系（普通管理员只看
自己名下用户）。

兼容性与上线顺序：两个字段都可选，两个 schema 的差异要记住——登录用 `extra="ignore"`，老服务端
遇到新客户端多发的字段会忽略；活动上报是 `extra="forbid"`，**新客户端打旧服务端会 422**，所以必须
先部署后端、再分发客户端。

必须记住的局限：它不是「一台机器的唯一码」，只是「一个系统实例的码」。Windows 重装系统、
sysprep 封装或直接克隆镜像会变或重复（多台机器可能报同一个值）；macOS 更换逻辑板、用迁移助理
换机会变；Linux 容器里可能每次启动都变。本机管理员可以修改这些值，因此**只适合审计与运营告警，
不能作为授权或安全边界**。该值属于可识别设备标识符，桌面端面向用户时应做相应告知。

## 通用文件上传

上传目录和单文件大小限制通过环境变量配置：

```bash
VESTUS_UPLOAD_DIR=/var/lib/vestus/uploads
VESTUS_UPLOAD_MAX_BYTES=10485760
```

`VESTUS_UPLOAD_DIR` 未设置时默认为仓库根目录下的 `uploads/`；`VESTUS_UPLOAD_MAX_BYTES`
未设置、格式无效或不为正数时默认为 10485760 字节（10 MiB）。生产环境应将上传目录配置为持久化
磁盘，并在容器部署中把持久卷挂载到该目录，否则容器重建会丢失文件。

上传路由先完成 `admin_auth`，成功后才解析 multipart，因此未认证请求不会触发 form parsing。
解析器只允许唯一一个 `file` 文件、零个普通字段。纯 ASGI 入口按每条 `receive` 消息累计实际字节，
不依赖 `Content-Length`；总请求体限制为 `VESTUS_UPLOAD_MAX_BYTES + 65536` 字节，其中固定
65,536 字节用于 multipart boundary 和文件头，文件内容仍精确受 `VESTUS_UPLOAD_MAX_BYTES` 限制。
运行时必须安装 `python-multipart>=0.0.32,<1`。

- `POST /api/admin/uploads`：仅管理员可调用；请求为 `multipart/form-data`，文件字段名为
  `file`，成功返回 HTTP 201。响应包含 `id`、`name`、`path`、`url`、`contentType`、`size`
  和 `createdAt`。
- `GET /uploads/{file_path}`：公开读取，无需登录。只有数据库中有对应记录且磁盘文件存在时
  才返回 200；其他情况返回 404。

数据库 `uploaded_file.path` 只保存形如 `/uploads/2026/08/<uuid>.pdf` 的相对路径，不保存
服务器绝对路径、协议或域名。上传响应的 `url` 在响应时使用当前请求的 `Host` 和协议生成，
因此会反映访问请求所用的域名。

通用上传本身允许任意文件类型；用作系统 Logo 或平台图标时则只接受本系统上传记录中的
PNG、JPEG、GIF、WebP、ICO，且配置表仍只保存 `path` 半路径。SVG、`data:`、外部 URL、失联
上传记录和伪造路径不能写入品牌/平台配置。管理接口返回半路径；面向桌面端的公开配置接口
按当前 API 域名生成完整 URL。

通过反向代理部署时，代理必须传递真实的 `Host` 和 `X-Forwarded-Proto`，并在 Uvicorn/ASGI
服务器上只对明确的代理地址启用可信代理头（例如 `--proxy-headers --forwarded-allow-ips=<proxy-ip>`）。
这样生成的 `url` 和请求来源 IP 才会反映外部连接；不要对不受信任的客户端开放这些转发头。

## 直连域名（bypassHosts）

`proxy` 表的 `bypass_hosts` 列（JSON 字符串数组）记录不走全局代理、由客户端直接连接的主机名，
`NULL` 或空数组表示全部流量走该代理。`POST/PATCH /api/admin/proxies` 用 `bypassHosts` 读写，
`GET /api/admin/proxies` 与 `GET /api/user/desktop-config` 都会返回归一化后的列表，并且它已
计入配置 lease——只改直连域名同样会让桌面端重建路由。

写法与校验规则（`app/schemas/proxies.py` 的 `validate_bypass_hosts` 与
`desktop/src-tauri/src/bypass.rs` 完全一致，两侧都会校验，任何一条不合法就整份配置拒绝）：

- `host.example.com` 精确匹配该主机；`*.example.com`（或等价的 `.example.com`）只匹配子域，
  不含 `example.com` 本身；统一按小写、`*.` 前缀形式存储。
- 最多 32 条，单条不超过 253 字符，每个标签不超过 63 字符。
- 只接受 ASCII 主机名：不允许协议、端口、路径、`@`、空白，中文域名请填 punycode。
- 拒绝 IP 字面量、`localhost`/`*.localhost` 和单标签域名。客户端在真正连接前还会解析一次，
  命中回环、未指定、组播、广播或链路本地地址一律拒绝；内网段保留放行，便于直连内部平台。

安全影响：直连流量不经过代理，使用**用户本机的真实出口 IP**，也不携带任何代理凭据。直连
失败固定返回 502（响应头 `X-Vestus-Direct-Error` 给出短代码），不会退回代理；反向同理，
代理失败也不会改成直连。

升级已有数据库时不要只执行单条 `ALTER`，按下面的「数据库迁移」执行。

## 数据库迁移

表结构由 Alembic 管理：配置在 [alembic.ini](../alembic.ini)，脚本在 [migrations/](../migrations/)。
数据库地址不写在 ini 里，而是按 `-x url=...` → `VESTUS_DATABASE_URL` 的顺序解析，所以迁移和服务
永远读同一个地址。

日常只需要一条命令，它对三种库都安全：

```bash
python3 scripts/init_db.py
```

- 空库：按迁移建表，再引导首个管理员。
- 已被 Alembic 管理的库（存在 `alembic_version` 表）：升级到 head。
- Alembic 之前就存在的库（有 `admin` 表但没有 `alembic_version`）：先 `stamp 0001` 接管，不重放
  建表语句，再继续升级。基线 `0001` 与当前 ORM `create_all()` 的结果逐表逐列一致。

后续新增变更：

```bash
alembic revision --autogenerate -m "add xxx"
alembic upgrade head
```

`0001` 之前的历史 MySQL 库如果还缺平台图标列、直连域名列、系统设置表或上传记录表，先备份，再运行
本版本可重复执行的完整迁移，然后交给 `scripts/init_db.py` 接管：

```bash
mysql vestus < deploy/migrations/2026-08-27-settings-and-uploads.sql
```

## 测试

测试使用显式临时 SQLite，不会连接生产 MySQL：

```bash
python3 -m pip install -r requirements.txt -r requirements-dev.txt
python3 -m pytest -q tests
```

同一套依赖还提供三项静态检查，改动后端后建议一起跑：

```bash
python3 -m ruff check .
python3 -m mypy
lint-imports
```

完整 Linux 生产部署步骤见 [deploy-linux.md](deploy-linux.md)。
