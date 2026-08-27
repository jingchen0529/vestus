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

代码使用 FastAPI + SQLAlchemy + PyMySQL，全部放在仓库根目录。MySQL 是默认数据库；不会创建旧版
`users`、`sessions` 或 `audit_logs` 表。首次启动会自动创建上述七张表，也可以执行
`python3 init_db.py` 或手动导入 `schema.sql`。

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

桌面端登录后由 Rust 持有 `access_token` 并作为 `Authorization: Bearer <token>` 发送，令牌
不会进入 React/JavaScript。后台登录只使用 HttpOnly Cookie。令牌有效期和账号表中的
`token_version` 会在每次请求校验；停用、重置密码、退出登录后旧令牌立即失效。桌面端还会
定期校验配置 lease；管理员变更或撤销代理/平台分配后，旧代理和浏览器会被关闭。

生产环境必须固定设置 `VESTUS_SECRET_KEY` 与 `VESTUS_PROXY_SECRET_KEY`；代理密码下发链路必须使用
HTTPS，桌面端需在构建时设置 `VESTUS_API_BASE_URL=https://...`。同时建议启用 Secure Cookie 和
可信反向代理配置。更换代理加密密钥前，需要先制定已有密文的迁移方案，否则旧代理密码将无法
解密。代理密码下发到桌面端后只保留在当前 Rust 会话内存，不会写入本地 JSON 或系统密钥链。

## 测试

测试使用显式临时 SQLite，不会连接生产 MySQL：

```bash
python3 -m pip install -r requirements.txt -r requirements-dev.txt
python3 -m pytest -q tests
```
