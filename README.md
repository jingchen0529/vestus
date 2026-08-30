# Vestus

Vestus 现在分成两个明确入口：

- Web `/admin` 只供管理员使用，用来维护桌面用户、全局代理和平台入口。
- Rust/Tauri 桌面端只供桌面用户登录；登录后从服务端同步全局配置，测试代理，再打开独立 Chromium 环境。

所有处于 `active` 状态的平台都会提供给全部桌面用户。代理同一时刻最多有一个处于 `active` 状态，
并由全部桌面用户共享；启用新代理会自动停用旧代理。也可以暂时停用全部代理，此时客户端仍可使用
保留的直连模式。历史 `user_proxy_assignment` / `user_platform_assignment` 表仅为兼容保留，桌面配置读取
不会再按用户读取这些表。

桌面端不提供手工填写代理的入口。代理口令在服务端数据库中加密保存，下发后只存在于当前 Rust 会话内存；不会进入 React、代理 URL 或本地配置文件。代理不可用时本地适配器返回错误，不会回退到本机直连。

管理员可以给每条代理配置一份「直连域名」清单（例如 `lf3-ad-platform.byteadverts.com`、`*.byteadverts.com`）。命中清单的请求由客户端直接连接，不经过代理；未命中的一律走代理。两条路径互不回退：代理失败回 502/407，直连失败回 502。规则、校验和安全边界见 [docs/backend.md](docs/backend.md#直连域名bypasshosts)。

桌面端只负责「登录后按服务端下发的平台打开浏览器」，和 OA 的语义一致：Rust 把起始网址作为命令行参数交给独立 Chromium，不与浏览器建立任何控制通道，也不开调试端点。打开之后页面完全由用户自己操作，客户端不做页面自动化。

## 目录结构

```
.                       Python 后端（FastAPI），直接放在仓库根目录
├── app/                后端应用包，入口 uvicorn app.main:app
│   ├── main.py         create_app()：中间件、路由注册、异常处理
│   ├── api/            HTTP 层：路由、依赖注入、响应封装
│   ├── services/       业务用例与事务边界（只有这一层提交事务）
│   ├── schemas/        Pydantic 请求/响应模型与序列化
│   ├── repositories/   纯查询层，不提交事务
│   ├── db/             SQLAlchemy 模型、引擎与会话
│   └── core/           配置、口令散列与令牌、上传存储、中间件
├── migrations/         Alembic 迁移（0001_baseline 对应现网表结构）
├── alembic.ini         Alembic 配置，数据库地址来自 VESTUS_DATABASE_URL
├── scripts/init_db.py  建表/迁移与首个管理员引导
├── requirements.txt    运行依赖（requirements-dev.txt 为测试依赖）
├── tests/              后端测试（临时 SQLite，不连生产 MySQL）
├── web/                后台管理前端（React + TypeScript + Tailwind + shadcn-ui）
│   ├── src/            前端源码（组件、数据模型、API 客户端、状态管理）
│   ├── dist/           构建打包静态产物，由后端 /admin 路由与 /assets 静态托管
│   └── package.json    Web 端 npm 工程（支持 npm run dev / npm run build）
├── desktop/            桌面端（React + Vite + Tauri）
│   ├── src/            React 界面与服务层
│   ├── src-tauri/      Rust 内核：认证、代理适配器、直连路由、浏览器启动
│   ├── scripts/        边界检查、随包 Chromium 准备、发布版本号写入
│   ├── index.html      Vite 入口
│   └── package.json    桌面端 npm 工程
├── deploy/             Linux systemd、Nginx 配置模板与 MySQL 迁移
└── docs/               后端、Linux 部署与历史设计文档
```

后端按 `api → services → repositories → db` 单向分层，规则写在 [.importlinter](.importlinter) 里，
用 `lint-imports` 可以直接校验。

本地如需保留 `oa/`、`ad_browser/` 参考项目，可放在仓库根目录；两者均被 Git 忽略，
不属于 GitHub 仓库内容，也不参与构建或发布。

## 本地启动

先准备后端（在仓库根目录执行）：

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
# .env 里必须填一个真实的 VESTUS_SECRET_KEY（≥32 字符），否则服务拒绝启动
python3 scripts/init_db.py
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

再构建并运行桌面端。开发模式会使用 `VESTUS_CHROMIUM_PATH` 指定的 Chromium；macOS
开发环境未设置时会尝试系统 Chrome：

```bash
cd desktop
npm install
VESTUS_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run desktop:dev
```

本地开发默认连接 `http://127.0.0.1:8000`。生产打包必须把后端地址设为 HTTPS，例如：

```bash
cd desktop
VESTUS_API_BASE_URL='https://api.example.com' npm run desktop:build
```

正式发布覆盖四个目标：Windows x86_64（NSIS）、macOS arm64 与 x86_64（dmg）、Linux
x86_64（deb / AppImage）。随包 Chromium 不能跨平台也不能跨架构，因此每个目标都在对应的
GitHub runner 上原生构建，构建时下载锁定版本（Playwright 1.62.1）的浏览器资源并放进安装包；
不需要上传 OA 的 `bin/`、`packages/` 等大型产物。`oa/` 仅作为只读参考，不参与 Rust 客户端
编译。每次点击平台都会启动一个新的进程和临时 Profile；同平台及不同平台均可并行，关闭后
清理本次 Profile，不保存 Cookie。

平台差异：macOS 包未做 Apple 签名与公证，首次打开需右键 →「打开」；Linux 未启用系统钥匙串
后端，登录状态只保留在应用运行期间，重启客户端要重新登录。

服务端可通过 `VESTUS_PRODUCT_NAME` 设置登录页、主界面和窗口标题显示的产品名称。

## 通用文件上传

上传接口仅允许管理员调用：

- `POST /api/admin/uploads`：使用 `multipart/form-data` 的 `file` 字段上传，成功返回 HTTP 201。
- `GET /uploads/{file_path}`：无需登录即可读取已上传文件；不存在的数据库记录或磁盘文件返回 404。

上传路由先完成管理员认证，再解析 multipart；解析器只接受唯一一个 `file` 文件，不接受普通字段。
入口通过纯 ASGI `receive` 计数限制实际请求体，即使请求没有 `Content-Length` 或采用分块发送也会生效。
总请求体上限固定为 `VESTUS_UPLOAD_MAX_BYTES + 65536` 字节（65,536 字节用于 multipart boundary
和文件头），文件内容本身仍严格受 `VESTUS_UPLOAD_MAX_BYTES` 限制。multipart 运行依赖要求
`python-multipart>=0.0.32,<1`。

部署时设置上传目录和单文件上限：

```bash
VESTUS_UPLOAD_DIR=/var/lib/vestus/uploads
VESTUS_UPLOAD_MAX_BYTES=10485760
```

前者默认是仓库根目录下的 `uploads/`，后者默认是 10485760 字节（10 MiB）。容器部署必须把
`/var/lib/vestus/uploads` 配置为持久卷，避免容器重建丢失文件。数据库只保存
`/uploads/YYYY/MM/<uuid>.<ext>` 形式的相对路径；完整 `url` 不入库，而是按请求当前的
`Host` 和协议生成。使用反向代理时，请传递真实 `Host` 与 `X-Forwarded-Proto`，并在 Uvicorn
上仅对明确的代理地址启用可信代理头（例如 `--proxy-headers --forwarded-allow-ips=<proxy-ip>`），
以确保响应 URL 使用正确的外部 HTTPS 域名。

通用接口允许上传任意类型文件；系统 Logo 和平台图标只允许引用本系统已上传的 PNG、JPEG、
GIF、WebP 或 ICO。配置表继续只保存半路径，不接受 `data:` 或外部图片 URL。

首次使用顺序：访问 `/admin`，创建桌面用户和代理/平台，并启用要向全部桌面用户提供的代理与平台；随后在桌面端使用任一用户登录。管理员重置的临时密码必须先在桌面端修改，之后才会下发配置。

Linux 生产部署见 [docs/deploy-linux.md](docs/deploy-linux.md)；环境变量和接口说明见
[docs/backend.md](docs/backend.md)。

## GitHub 打包

`.github/workflows/release.yml` 一次并行构建四个平台：Windows x86_64（`.exe`）、macOS
arm64 与 x86_64（`.dmg`）、Linux x86_64（`.deb` / `.AppImage`）。

- **发版**：推送 `desktop-v1.2.3` 形式的标签。四个平台全部构建成功后自动创建 GitHub
  Release 并挂上安装包；标签里的版本号会写进 `tauri.conf.json`，成为安装包版本。
- **试跑**：手工运行 `Release` 工作流，只构建、不发版，产物在该次 Actions 的 Artifacts 里
  （保留 14 天）。可在触发表单里填 `api_base_url` 覆盖后端地址。
- **后端地址**：正式标签必须设置仓库 Secret `VESTUS_API_BASE_URL`，并且必须为 HTTPS；缺失或
  使用 HTTP 时构建直接失败，不会发布不可登录或明文传输凭据的 Release。手工试跑优先取表单
  输入，其次取 Secret；两者都没有时才使用 `https://vestus.invalid` 占位。手工试跑可显式填写
  HTTP 地址做联调，但这种 Artifact 不得分发。

本地复现某个平台的发布包（在对应操作系统上执行）：

```bash
cd desktop
npm ci
node scripts/prepare-chromium.mjs   # 下载并铺好随包 Chromium
VESTUS_API_BASE_URL='https://api.example.com' npm run desktop:build
```

## 验证

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q tests
python3 -m ruff check .
python3 -m mypy
lint-imports                          # 校验后端分层
cd web
npm run build
cd ../desktop
npm run build
npm run check:surfaces
cd src-tauri
cargo test --all-targets
```

说明：本地代理只监听随机的 `127.0.0.1` 端口，能够隔离局域网访问，但操作系统上的其他本地进程理论上仍可能探测并使用该端口；如果部署环境把同机恶意进程纳入威胁模型，还需要增加操作系统级进程隔离。

直连域名的流量不经过代理，会暴露用户本机的真实出口 IP，也不携带任何代理凭据；请只把确实需要直连的站点放进清单。
