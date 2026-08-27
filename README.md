# Vestus

Vestus 现在分成两个明确入口：

- Web `/admin` 只供管理员使用，用来维护桌面用户、代理、平台入口和用户分配关系。
- Rust/Tauri 桌面端只供桌面用户登录；登录后从服务端同步本人配置，测试代理，再打开独立 Chromium 环境。

桌面端不提供手工填写代理的入口。代理口令在服务端数据库中加密保存，下发后只存在于当前 Rust 会话内存；不会进入 React、代理 URL 或本地配置文件。代理不可用时本地适配器返回错误，不会回退到本机直连。

## 目录结构

```
.                       Python 后端（FastAPI），直接放在仓库根目录
├── app.py              API 入口，uvicorn app:app
├── db.py               SQLAlchemy 模型与数据访问
├── security.py         口令散列、令牌、代理口令加解密
├── init_db.py          建表与首个管理员引导
├── requirements.txt    运行依赖（requirements-dev.txt 为测试依赖）
├── schema.sql          手工建表脚本
├── tests/              后端测试（临时 SQLite，不连生产 MySQL）
├── web/                后台管理前端，由后端 /admin 路由直接返回
│   └── admin.html
├── desktop/            桌面端（React + Vite + Tauri）
│   ├── src/            React 界面与服务层
│   ├── src-tauri/      Rust 内核：认证、代理适配器、浏览器启动
│   ├── scripts/        边界检查与 Windows Chromium 准备脚本
│   ├── index.html      Vite 入口
│   └── package.json    桌面端 npm 工程
├── docs/               后端与历史设计文档
├── oa/                 只读参考项目，不参与编译
└── ad_browser/         只读参考项目
```

## 本地启动

先准备后端（在仓库根目录执行）：

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --host 127.0.0.1 --port 8000
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

正式发布目标与 OA 一致，仅支持 Windows x86_64/NSIS；macOS 只用于开发调试，不生成
发布安装包。`oa/` 仅作为只读参考，不参与 Rust 客户端编译。GitHub Windows 工作流会在
构建时准备锁定版本的浏览器资源并放入安装包，因此不需要上传 OA 的 `bin/`、`packages/`
等大型产物。每次点击平台都会启动一个新的进程和临时 Profile；同平台及不同平台均可
并行，关闭后清理本次 Profile，不保存 Cookie。

服务端可通过 `VESTUS_PRODUCT_NAME` 设置登录页、主界面和窗口标题显示的产品名称。

首次使用顺序：访问 `/admin`，创建桌面用户和代理/平台，再给用户分配一条代理及所需平台；随后在桌面端使用该用户登录。管理员重置的临时密码必须先在桌面端修改，之后才会下发配置。

后端部署、环境变量和接口说明见 [docs/backend.md](docs/backend.md)。

## GitHub 打包

在仓库 Secrets 中设置 `VESTUS_API_BASE_URL`（必须为 HTTPS），然后手工运行
`Windows desktop NSIS` 工作流，或推送 `desktop-v*` 标签。成功后可在该次 Actions 的
Artifacts 中下载 NSIS 安装程序。

## 验证

```bash
python3 -m pytest -q tests
cd desktop
npm run build
npm run check:surfaces
cd src-tauri
cargo test --all-targets
```

说明：本地代理只监听随机的 `127.0.0.1` 端口，能够隔离局域网访问，但操作系统上的其他本地进程理论上仍可能探测并使用该端口；如果部署环境把同机恶意进程纳入威胁模型，还需要增加操作系统级进程隔离。
