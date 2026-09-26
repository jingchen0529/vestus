# Vestus

Vestus 是一套「带认证的受控浏览器」系统：广告代理公司的运营人员通过桌面客户端登录后，从
服务端领取分配的代理线路与平台入口，在一个**持久、隔离、可审计**的独立 Chromium 环境里操作
巨量引擎等广告平台。管理端负责用户、代理、平台与操作记录的治理。

系统由三部分组成，代码全部在本仓库：

| 部分 | 技术 | 给谁用 | 干什么 |
| --- | --- | --- | --- |
| 后端 | Python + FastAPI + SQLAlchemy + MySQL | 两端共用 | 统一 API：两套认证、桌面配置下发、浏览器活动接收与查询、文件上传 |
| 管理端 | React + TypeScript + Tailwind + shadcn-ui | 管理员 | 用户与绑定、代理节点、平台入口、系统设置、会话追踪、审计日志 |
| 桌面端 | React 壳 + Rust（Tauri 2）内核 + 随包 Chromium | 桌面用户 | 登录、代理适配、打开平台浏览器、采集页面活动并上报 |

## 架构总览

```
┌──────────────┐        ┌─────────────────────────┐
│  管理端 Web  │───────▶│                         │
│  (React)     │  HTTPS │      Python 后端        │────▶ MySQL（业务数据）
└──────────────┘        │  FastAPI + /admin 托管  │────▶ 上传目录
                        │                         │
┌──────────────────────┐│                         │
│  桌面端（每台电脑）  ││                         │
│  ┌────────────────┐  │        │                 │
│  │ React 登录壳   │──┼─ IPC ─▶│                 │
│  └────────────────┘  │        ▼                 │
│  ┌────────────────┐  │   Rust 内核              │
│  │ 随包 Chromium  │◀─┼── 本地代理适配器 ────────┼──▶ 上游代理 / 直连出站
│  │ 持久 profile   │  │      │ 活动采集(CDP)      │
│  └────────────────┘  │      ▼ 批量上报            │
└──────────────────────┘└──────▶ HTTP API ──────────┘
```

一句话的数据流：管理员在管理端配置用户/代理/平台 → 桌面端登录后调用 `desktop-config` 拿到
属于自己的代理与平台清单 → 打开平台时 Rust 起一个随包 Chromium 进程，流量经本地适配器按
「直连域名清单」分流到代理或直连出站 → 页面活动（地址与操作次数）经 DevTools 协议采集后
批量上报，管理端在「会话追踪」里查看明细与按天汇总。

权限模型：桌面用户通过 `user.bound_admin_id` 归属到某个管理员，普通管理员（`role=admin`）
只能看到自己名下用户的列表、统计、会话追踪与审计日志，越界一律 404；超级管理员不受限。
代理节点、平台与系统配置属于全局资源，读写只开放给超级管理员。

## 代码导览

### 后端 `app/`（Python，FastAPI）

严格单向分层 `api → services → repositories → db`，规则由 [.importlinter](.importlinter)
约束（`lint-imports` 可校验）：**只有 services 层提交事务**，repositories 只做查询与写入
不提交，api 层只做认证、参数解析与响应封装。

| 目录 / 文件 | 职责 |
| --- | --- |
| `app/main.py` | `create_app()`：中间件、路由注册、异常处理、静态资源挂载 |
| `app/api/` | HTTP 层。`deps.py` 依赖注入（管理员/用户两套认证、分页数据库会话）；`envelope.py` 统一响应信封 `{code, msg, data}`；`routers/` 按资源拆分的路由 |
| `app/api/routers/` | 路由：`admin_auth` / `user_auth` / `legacy_auth`（两套登录 + 旧接口兼容）、`admins`（管理员管理，超管专属）、`users`（桌面用户与绑定）、`proxies`（代理节点与直连域名）、`platforms`（平台入口）、`settings`（系统设置）、`uploads`（文件上传）、`logs`（审计日志）、`browser_activity`（桌面端上报 + 管理端会话追踪/按天汇总/ID 导出）、`desktop`（桌面配置下发与租约）、`client`（旧版客户端兼容占位）、`system`（`/healthz`、产品信息、`/admin` 静态托管） |
| `app/services/` | 业务用例与事务边界。除与 repositories 同名的资源服务外：`desktop.py`（桌面配置的组装与租约）、`audit.py`（审计写入）、`errors.py`（业务错误类型） |
| `app/repositories/` | 纯查询层，按表组织；`browser_activity.py` 里同时包含增量的会话合并写入与按天聚合读取 |
| `app/schemas/` | Pydantic 请求/响应模型；`serializers.py` 是 ORM → 响应字典的统一序列化；上报模型（`browser_activity.py`）在这里执行**采集边界**：剥离 query 中的敏感值、丢弃超限快照，不信任桌面客户端 |
| `app/db/models/` | SQLAlchemy 模型，按表拆分：`admin`、`user`、`proxy`、`platform`、`browser_activity`（`browser_session` + `browser_page_visit` 两张表）、`log`（审计）、`setting`、`upload`、`assignment`（历史分配表，仅兼容保留） |
| `app/core/` | 横切设施：`config.py`（环境变量）、`security.py`（口令散列与令牌）、`device.py`（三平台机器标识归一化）、`middleware.py`、`uploads.py`（上传存储）、`api_contract.py` |

`migrations/` 是 Alembic 迁移（`0001_baseline` 对应现网表结构，`0006` 为设备标识列），
数据库地址来自 `VESTUS_DATABASE_URL`；`scripts/init_db.py` 在服务启动前自动建表/升级并引导
首个管理员，空库、被 Alembic 管理的库、Alembic 之前的库三类都能安全执行。

### 桌面端 Rust 内核 `desktop/src-tauri/src/`

Tauri 2 应用：React 只做登录壳与界面，所有安全敏感逻辑都在 Rust。15 个模块各有专责：

| 模块 | 职责 |
| --- | --- |
| `httpio` | 最小 HTTP 报文头解析（不引重型 HTTP 栈） |
| `upstream` | 上游代理连接：为 Chromium 补 Basic 认证、重写请求头 |
| `bypass` | 管理员下发的直连域名列表——第二个也是最后一个出站点 |
| `adapter` | 本地 HTTP 代理适配器：监听 127.0.0.1 随机端口，按直连域名把流量路由到代理或直连，两条路径互不回退 |
| `probe` | 出口 IP 探测（管理端展示「当前出口」） |
| `config` | 服务端下发的代理/平台配置的内存校验（结构、类型、合法性） |
| `device` | 操作系统机器标识：macOS `IOPlatformUUID`、Windows `MachineGuid`、Linux `/etc/machine-id`，best-effort 读取 |
| `auth` | 桌面用户认证：登录/恢复/登出/改密，令牌仅存 Rust 进程与系统钥匙串（Linux 降级为进程内存） |
| `profile` | 持久浏览器环境：profile 目录按「服务器 × 账号 × 平台 × 代理/直连」隔离；单例占用检测与残留锁清理；按账号重置 |
| `browser` | Chromium 多会话管理：一个环境一个进程、命令行转交复用、优雅关闭（CDP → SIGTERM → 强杀）保 Cookie 落盘 |
| `cdp` | DevTools 协议：只读采集页面地址与操作计数（autoAttach + 注入固定计数脚本）；另有一条一次性控制连接负责 `Browser.close` 与「切回已有标签页」的 Target 命令 |
| `activity` | 采集结果的内存聚合与 30 秒批量上报（失败合回下批，不丢数据） |
| `state` | 运行状态机：未配置 → 就绪 → 浏览器运行；会话槽位与关停顺序 |
| `commands` | 暴露给 React 的全部 IPC 命令（同步配置、打开/重置浏览器、直连 IP、状态查询） |
| `rt` | 应用自有 Tokio 运行时（本地代理适配器与上报在 Tauri 事件循环之外长驻） |

### 桌面端前端 `desktop/src/`

React 界面只做展示与交互：`components/auth`（登录/改密）、`components/browser`
（平台启动器）、`components/settings`（系统配置：代理开关、沙箱开关、浏览器环境重置、
主题）；`services/tauriBridge.ts` 是唯一允许调用 Tauri IPC 的出口，`scripts/check-surface-boundaries.mjs`
在 CI 里静态守护这条边界（前端不得触达 Rust 以外的能力、采集连接必须只读）。

### 管理端前端 `web/src/`

React 管理后台：`components/` 按页面分组（`activity` 会话追踪与按天汇总、`users`、`admins`、
`proxies`、`platforms`、`settings`、`logs`、`dashboard`、`auth`、`layout`），`lib/api-client.ts`
是唯一出口的 API 客户端，`types/` 与后端响应字段一一对应。构建产物 `web/dist` 由后端
`/admin` 路由托管（split 模式的 Nginx 也可直接托管静态根）。

## 目录结构

```
.                       Python 后端（FastAPI），直接放在仓库根目录
├── app/                后端应用包，入口 uvicorn app.main:app（分层见上）
├── migrations/         Alembic 迁移
├── alembic.ini         Alembic 配置，数据库地址来自 VESTUS_DATABASE_URL
├── scripts/init_db.py  建表/迁移与首个管理员引导
├── requirements.txt    运行依赖（requirements-dev.txt 为测试依赖）
├── tests/              后端测试（临时 SQLite，不连生产 MySQL）
├── web/                管理端前端（React + TS + Tailwind + shadcn-ui）
├── desktop/            桌面端（React + Vite + Tauri 2）
│   ├── src/            React 界面与服务层
│   ├── src-tauri/      Rust 内核（模块见上）与打包配置
│   └── scripts/        边界检查、随包 Chromium 准备、发布版本号写入
├── deploy/             Linux systemd、Nginx 配置模板与 MySQL 迁移
└── docs/               backend.md（环境变量与接口）、deploy-linux.md（生产部署）、
                        desktop-user-guide.md（桌面用户手册）、历史设计文档
```

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

再构建并运行桌面端。`npm run desktop:dev` 会自动把 `VESTUS_CHROMIUM_PATH` 指向
`desktop/src-tauri/resources/chromium/` 里那份随包 Chromium（先跑一次
`node scripts/prepare-chromium.mjs` 铺好它）；显式设了这个变量就用你指定的，两者都没有时
macOS 会回退到系统装的 Chrome：

```bash
cd desktop
npm install
node scripts/prepare-chromium.mjs
npm run desktop:dev
```

dev 刻意指向 `resources/` 这个复制源，而不是 `tauri dev` 复制到 `target/debug/chromium/`
的那份副本：那次复制是原地覆盖，覆盖到正在运行的 Chromium 会让内核记下对不上的代码签名，
之后那个路径每次启动都被 `SIGKILL (Code Signature Invalid)` 直接杀掉，只能删掉目录重铺。
理由写在 `scripts/tauri-with-api.mjs:devChromiumOverride`。

本地开发默认连接 `http://127.0.0.1:8000`。首次使用顺序：访问 `/admin`，创建桌面用户和
代理/平台，并启用要向全部桌面用户提供的代理与平台；随后在桌面端使用任一用户登录。管理员
重置的临时密码必须先在桌面端修改，之后才会下发配置。

## 打包与发布

正式发布覆盖四个目标：Windows x86_64（NSIS `.exe`）、macOS arm64 与 x86_64（`.dmg`）、
Linux x86_64（`.deb` / `.AppImage`）。随包 Chromium 不能跨平台也不能跨架构，因此每个目标
都在对应的 GitHub runner 上原生构建，构建时下载锁定版本（Playwright 1.63.0）的浏览器资源
并放进安装包。

`.github/workflows/release.yml` 的触发方式：

- **发版**：推送 `desktop-v1.2.3` 形式的标签。四个平台全部构建成功后自动创建 GitHub
  Release 并挂上安装包；标签里的版本号会写进 `tauri.conf.json`，成为安装包版本。
- **试跑**：手工运行 `Release` 工作流，只构建、不发版，产物在该次 Actions 的 Artifacts 里
  （保留 14 天）。可在触发表单里填 `api_base_url` 覆盖后端地址。
- **后端地址**：正式标签必须设置仓库 Secret `VESTUS_API_BASE_URL`，并且必须为 HTTPS；缺失或
  使用 HTTP 时构建直接失败，不会发布不可登录或明文传输凭据的 Release。

本地复现某个平台的发布包（在对应操作系统上执行）：

```bash
cd desktop
npm ci
node scripts/prepare-chromium.mjs   # 下载并铺好随包 Chromium
VESTUS_API_BASE_URL='https://api.example.com' npm run desktop:build
```

平台差异：macOS 包未做 Apple 签名与公证（ad-hoc 签名），首次打开需右键 →「打开」；Linux 未
启用系统钥匙串后端，登录状态只保留在应用运行期间，重启客户端要重新登录。

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
npm test && npm run build
npm run check:surfaces                # 采集边界与 IPC 表面静态检查
cd src-tauri
cargo test --all-targets
```

## 关键行为与安全边界

**持久浏览器环境**：每个平台在每台电脑上有一套单独保存的 Chromium profile，关掉浏览器后
Cookie 与登录状态保留，下次打开平台看到的还是同一台设备。环境按「服务器 × 桌面账号 × 平台 ×
代理/直连」隔离——同一台电脑上登录多个账号时彼此不可见；同一账号在多台电脑上登录时每台
电脑各有一套，互不同步。重复点击同一平台会切回已打开的标签页（页面原样保留），而不是再开
一个起始页。环境保存在应用数据目录（macOS `~/Library/Application Support/com.zhixi.vestus/browser-profiles/`、
Windows `%LOCALAPPDATA%\com.zhixi.vestus\browser-profiles\`、Linux `~/.local/share/com.zhixi.vestus/browser-profiles/`）；
「系统配置 → 浏览器环境」可以清除当前账号在本机的全部环境。细节见
[docs/desktop-user-guide.md](docs/desktop-user-guide.md#72-浏览器环境)。

**代理与直连**：桌面端不提供手工填写代理的入口。代理口令在服务端数据库中加密保存，下发后
只存在于当前 Rust 会话内存；不会进入 React、代理 URL 或本地配置文件。代理不可用时本地适配器
返回错误，不会回退到本机直连。管理员可给每条代理配「直连域名」清单：命中的请求由客户端直连，
未命中一律走代理，两条路径互不回退。直连流量暴露本机真实出口 IP 且不携带代理凭据，只把确实
需要直连的站点放进清单。规则见 [docs/backend.md](docs/backend.md#直连域名bypasshosts)。

**活动采集边界**：客户端不做页面自动化，页面完全由用户自己操作。采集只包含页面地址（含脱敏
后的 query）与操作次数；页面标题、点击元素、按键、凭据与敏感表单字段一律不进采集范围，输入/
提交只保留最近一条字段名快照（值不保存）。这条边界由 `npm run check:surfaces` 与 cdp.rs 单测
共同守护。管理端「会话追踪」能看到明细与按天汇总（用户 × 设备 × 平台 × 东八区自然日）。

**设备标识**：桌面端上报操作系统暴露的机器标识（macOS `IOPlatformUUID`、Windows `MachineGuid`、
Linux `/etc/machine-id`），用于会话归属与审计展示。读取失败或值不合规时上报为空，采集绝不
影响登录与上报；老版本客户端不带该字段也照常工作。注意它的局限：重装系统、换逻辑板、容器
重建都会变，克隆镜像可能重复——只适合审计与告警，不能当安全边界。见 [docs/backend.md](docs/backend.md#设备标识)。

**通用文件上传**：`POST /api/admin/uploads` 仅管理员可调用，总请求体上限固定为
`VESTUS_UPLOAD_MAX_BYTES + 65536` 字节；`GET /uploads/{file_path}` 公开读取。数据库只存
`/uploads/YYYY/MM/<uuid>.<ext>` 相对路径，完整 URL 按请求 `Host` 生成。系统 Logo 和平台图标
只允许引用本系统已上传的图片格式。环境变量与接口细节见 [docs/backend.md](docs/backend.md)。

**本地端口说明**：本地代理只监听随机的 `127.0.0.1` 端口，能够隔离局域网访问，但操作系统上的
其他本地进程理论上仍可能探测并使用该端口；如果部署环境把同机恶意进程纳入威胁模型，还需要
增加操作系统级进程隔离。

Linux 生产部署见 [docs/deploy-linux.md](docs/deploy-linux.md)；环境变量和接口说明见
[docs/backend.md](docs/backend.md)；面向桌面端用户的使用手册见
[docs/desktop-user-guide.md](docs/desktop-user-guide.md)。
