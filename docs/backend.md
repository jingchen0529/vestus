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
- `proxy` / `platform`：管理员维护的代理和平台入口
- `user_proxy_assignment` / `user_platform_assignment`：桌面用户配置关联
- `system_setting`：产品名称、Logo 与界面颜色配置
- `uploaded_file`：上传文件元数据（只保存相对路径）

代码使用 FastAPI + SQLAlchemy + PyMySQL，全部放在仓库根目录。MySQL 是默认数据库；不会创建旧版
`users`、`sessions` 或 `audit_logs` 表。全新空库使用 `python3 init_db.py` 按当前 ORM 建表；
生产部署不要直接依赖旧版本的 `schema.sql`。已有数据库必须执行明确的迁移 SQL，因为
SQLAlchemy `create_all()` 不会给旧表自动增加列。

## 启动

在仓库根目录执行：

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

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
VESTUS_DATABASE_URL='sqlite:////tmp/vestus-test.db' uvicorn app:app
```

## 接口概览

- 管理员认证：`POST/GET /api/admin/auth/login|me`，`POST /api/admin/auth/logout`
- 管理员管理：`/api/admin/admins`
- 桌面端用户认证：`POST/GET /api/user/auth/login|me`，`POST /api/user/auth/logout|change-password`
- 桌面端用户管理：`/api/admin/users`
- 代理和平台管理：`/api/admin/proxies`、`/api/admin/platforms`
- 用户桌面配置：管理员 `/api/admin/users/{id}/desktop-config`，桌面端 `/api/user/desktop-config`
- 配置存续校验：桌面端 `GET /api/user/desktop-config/lease`
- 产品名称：登录前公开读取 `GET /api/product`
- 日志分页：`GET /api/admin/user-logs`
- 通用文件上传：管理员 `POST /api/admin/uploads`（multipart 字段 `file`），公开读取
  `GET /uploads/{file_path}`

桌面端登录后由 Rust 持有 `access_token` 并作为 `Authorization: Bearer <token>` 发送，令牌
不会进入 React/JavaScript。Web 管理端把登录响应中的令牌只保存在页面内存，同时用 HttpOnly
Cookie 支持刷新后的会话恢复；Cookie 认证的写请求还必须通过同源 `Origin` 校验。令牌有效期和
账号表中的 `token_version` 会在每次请求校验；停用、重置密码、退出登录后旧令牌立即失效。桌面端还会
定期校验配置 lease；管理员变更或撤销代理/平台分配后，旧代理和浏览器会被关闭。

生产环境必须固定设置 `VESTUS_SECRET_KEY` 与 `VESTUS_PROXY_SECRET_KEY`；代理密码下发链路必须使用
HTTPS，桌面端需在构建时设置 `VESTUS_API_BASE_URL=https://...`。同时建议启用 Secure Cookie 和
可信反向代理配置。更换代理加密密钥前，需要先制定已有密文的迁移方案，否则旧代理密码将无法
解密。代理密码下发到桌面端后只保留在当前 Rust 会话内存，不会写入本地 JSON 或系统密钥链。

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
这样生成的 `url` 才会使用外部 HTTPS 域名；不要对不受信任的客户端开放这些转发头。`VESTUS_TRUST_PROXY=1`
仅用于信任 `X-Forwarded-For` 记录客户端 IP，也必须只在请求确实来自受信任反向代理时启用。

## 直连域名（bypassHosts）

`proxy` 表的 `bypass_hosts` 列（JSON 字符串数组）记录不走代理、由客户端直接连接的主机名，
`NULL` 或空数组表示全部流量走该代理。`POST/PATCH /api/admin/proxies` 用 `bypassHosts` 读写，
`GET /api/admin/proxies` 与 `GET /api/user/desktop-config` 都会返回归一化后的列表，并且它已
计入配置 lease——只改直连域名同样会让桌面端重建路由。

写法与校验规则（`app.py` 的 `_validate_bypass_hosts` 与
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

升级已有数据库（本项目不使用 Alembic）时，不要只执行单条 `ALTER`。先备份，再运行本版本
可重复执行的完整迁移，它会同时补齐平台图标列、直连域名列、系统设置表和上传记录表：

```bash
mysql vestus < deploy/migrations/2026-08-27-settings-and-uploads.sql
```

## 测试

测试使用显式临时 SQLite，不会连接生产 MySQL：

```bash
python3 -m pip install -r requirements.txt -r requirements-dev.txt
python3 -m pytest -q tests
```

完整 Linux 生产部署步骤见 [deploy-linux.md](deploy-linux.md)。
