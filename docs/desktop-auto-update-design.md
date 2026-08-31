# 桌面端自动更新与后台版本管理设计

文档版本：v1
状态：设计待评审，尚未实现
适用范围：后台新增「版本更新」模块（上传安装包、发布版本、标记强制更新），桌面端接入
Tauri 官方 updater 后自行检查、下载、校验签名并安装。

## 1. 现状与要解决的问题

现在的发布链路到 GitHub Release 就断了：

```
推 desktop-v* 标签 → .github/workflows/release.yml 四平台原生构建 → 挂 GitHub Release
                                                                      ↓
                                                            管理员手工把安装包发给用户
```

`desktop/src-tauri/Cargo.toml` 里没有 `tauri-plugin-updater`，`tauri.conf.json` 里没有
`plugins.updater`，后台没有版本表也没有版本列表页。所以：

- 客户端不知道自己是否过期，只能等人通知；
- 后台无法确认线上还有多少台旧版本在跑；
- 后端一旦改动桌面端依赖的接口（响应信封、`bypassHosts`、活动上报都改过），旧客户端
  会静默失效，而管理员没有任何手段强制它们升级。

本设计要交付的目标状态：

```
推 desktop-v* 标签 → 四平台构建（含 minisign 签名）→ 产物 + .sig
                                                       ↓
                                    管理员在后台「版本更新」页上传、填说明、发布
                                                       ↓
                    桌面端启动时查 /api/desktop/update/check → 提示或强制
                                                       ↓
                    updater 插件走 /api/desktop/update/{target}/{arch}/{version}
                    下载 → 校验 minisign 签名 → 安装 → 重启
```

## 2. 方案选择

### 2.1 用 Tauri 官方 updater，不自研下载安装

`tauri-plugin-updater` v2 的核心价值不是省代码，而是**签名校验**：公钥在编译期写进
`tauri.conf.json` 的 `plugins.updater.pubkey`，随二进制固化；私钥只在 CI 的 Secrets 里。
客户端下载完成后先验签名再安装，验不过就拒绝。

这条性质决定了安全边界：**即使后台服务器被入侵、版本记录被改成指向恶意安装包，没有私钥
的攻击者也无法让任何客户端安装它。** 自研「下载 + 执行安装器」拿不到这个保证 —— 那等于给
后台开了一条对全部客户端的任意代码执行通道。这是选官方插件的唯一决定性理由。

### 2.2 安装包自托管在后台

产物落到 `VESTUS_UPLOAD_DIR`，走已有的 `/uploads/` 读取路径。国内下载可靠、内网部署可用，
与 `docs/deploy-linux.md` 现有部署形态一致，不引入云厂商凭据。

代价有两条，都要在实施时处理（见 §7 和 §8.3）：现有上传通道限 10 MiB，而安装包约
150–200 MB；`/uploads/` 现在由 FastAPI 的 `FileResponse` 提供，200 MB 文件经 Python 进程
转发会在更新高峰打满 uvicorn worker。

### 2.3 强制更新 + 普通提示，不做灰度

每个版本有一个「本版本必须升级」开关。桌面端从当前版本升到最新版的路径上，只要**经过**任何
一个被标记强制的版本，本次更新即为强制：拦在登录之前，不给「稍后」。否则只提示，可跳过。

不按用户/百分比分批推送。这套机制的价值在于「不让旧协议的客户端继续连后台」，灰度与该目标
相反，且会让「线上还有哪些版本」这个问题重新变得不可回答。

## 3. 关键约束（会决定实施顺序，务必先读）

### 3.1 第一个带 updater 的版本必须手工分发

公钥编译进包。已发出的 `0.1.8` 里没有 updater，也没有公钥，它永远不会自己检查更新。所以
带 updater 的首个版本（建议 `0.2.0`）仍需管理员手工发给用户，**从 0.2.0 起**才有自动更新。
后台的版本列表页在 0.2.0 之前就可以先上线，作为手工分发的下载页用。

### 3.2 打包目标要改：updater 用的产物和首次安装用的不是同一个文件

| 平台 | 现在的 target | 自动更新需要 | 说明 |
| --- | --- | --- | --- |
| macOS | `dmg` | `app`（产出 `.app.tar.gz`） | **updater 不能用 dmg**，必须加 `app` target；dmg 保留给首次安装 |
| Windows | `nsis` | `nsis`（`-setup.exe`） | 已满足，无需改动 |
| Linux | `deb`, `appimage` | `appimage`（`.AppImage.tar.gz`） | 已满足；**deb 装的不能自动更新**，只能提示手工下载 |

`desktop/src-tauri/tauri.macos.conf.json` 的 `targets` 要从 `["dmg"]` 改成 `["app", "dmg"]`。
配置了 `pubkey` 之后 Tauri 打包时会自动生成对应的 `.sig` 文件。

### 3.3 macOS 自动更新依赖代码签名与公证

未签名的 `.app` 替换后会被 Gatekeeper 拦下，用户看到的是「已损坏」。这正是审计报告 F-08
指出的缺口（`docs/Vestus审计报告-2026-08-28.md`）。**签名公证没落地之前，macOS 那一档只能
做到「提示 + 跳转手工下载 dmg」**，Windows 和 Linux 可以先跑完整自动更新。这不是本设计能
绕过的，实施时按平台分批交付。

### 3.4 包体积：每次更新约 180 MB

`desktop/src-tauri/resources/chromium/` 是 356 MB 未压缩，压缩后安装包约 150–200 MB。推论：

- 单个产物上限至少 512 MiB；
- 一个版本四平台的 updater 产物 + installer 产物合计约 1.2–1.5 GB 磁盘；
- 用户每次更新要下 ~180 MB，且**更新内容里绝大部分是没变过的 Chromium**。

所以 §9 列了留存策略（默认保留最近 3 个已发布版本的产物文件），并把「Chromium 拆成独立
版本化资源包，让应用主体更新降到 ~15 MB」列为本期之后最该做的优化。

### 3.5 updater 端点不套响应信封

Tauri 插件只认它自己的静态 JSON 格式。这会是 `/healthz` 之后**第二个**信封豁免端点，
所以它的 router 不能用 `EnvelopeRoute`，并且要在 `docs/backend.md` 里和 `/healthz` 一起
写明。策略接口 `/api/desktop/update/check` 是我们自己的，仍然套信封。

## 4. 数据模型

新增两张表，迁移 `migrations/versions/0003_app_release.py`，模型放
`app/db/models/app_release.py`。

### 4.1 `app_release`：一个版本一行

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | IdType PK | |
| `version` | String(32) UNIQUE | 语义化版本，存 `0.2.0`，不带 `desktop-v` 前缀 |
| `version_order` | BigInteger, index | `major*1_000_000 + minor*1_000 + patch`，供数据库排序 |
| `notes` | Text | 更新说明，纯文本，桌面端原样展示 |
| `mandatory` | Boolean, default False | 本版本是否必须升级 |
| `status` | String(16), index | `draft` / `published` / `archived` |
| `published_at` | DateTime6, nullable, index | 发布时刻，`draft` 为 NULL |
| `created_by` | IdType | 上传的管理员 |
| `created_at` / `updated_at` | DateTime6 | |

`version_order` 是刻意的冗余列：版本比较必须按数值，字符串比较会把 `0.10.0` 排在 `0.9.0`
前面，而「最新的已发布版本」和「路径上是否有强制版本」两个查询都要在 SQL 里排序。计算函数
`app/core/versions.py:parse_semver()` 只接受 `X.Y.Z` 三段数字，拒绝预发布后缀 —— 现在的
发布流程不产生 `-beta`，多支持一种格式就多一处排序歧义。

### 4.2 `app_release_artifact`：一个版本 × 一个平台 × 一种用途一行

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | IdType PK | |
| `release_id` | IdType, index | |
| `target` | String(16) | `darwin` / `windows` / `linux`，与 Tauri 的 `{{target}}` 一致 |
| `arch` | String(16) | `x86_64` / `aarch64` |
| `kind` | String(16) | `updater`（自动更新用）/ `installer`（首次安装用） |
| `upload_path` | String(255) | `/uploads/YYYY/MM/<uuid>.ext` 半路径，与现有上传记录同构 |
| `file_name` | String(255) | 原始文件名，下载时用 |
| `size` | BigInteger | |
| `signature` | Text, nullable | minisign 签名（`.sig` 的内容）；`kind=updater` 必填 |
| `sha256` | String(64) | 落盘时算出，供管理员核对与手工下载校验 |
| `created_at` | DateTime6 | |

唯一约束 `(release_id, target, arch, kind)`：同一个版本的同一平台同一用途只能有一个产物，
重复上传是替换而不是追加。

不复用 `uploaded_file` 表：那张表是「管理员上传的任意文件」，`GET /uploads/{path}` 的存在性
判断依赖它。安装包要有 `target`/`arch`/`signature`/`kind` 这些结构化字段，塞进通用表会让
两种语义纠缠。**实现上仍然为每个产物写一条 `uploaded_file` 记录**，否则 `/uploads/` 读取
路由查不到就会 404 —— 这条是必须的，容易漏。

## 5. 后台接口

路由 `app/api/routers/releases.py`（信封）与 `app/api/routers/desktop_update.py`（裸 JSON），
都要登记进 `app/api/routers/__init__.py:ROUTERS`。

### 5.1 管理员侧

```
GET    /api/admin/releases                 列表，分页，按 version_order 倒序
POST   /api/admin/releases                 建草稿：{version, notes, mandatory}
GET    /api/admin/releases/{id}            详情，含全部产物
PATCH  /api/admin/releases/{id}            改说明/强制标记；已发布的版本号不可改
POST   /api/admin/releases/{id}/artifacts  上传一个产物（multipart，见 §7）
DELETE /api/admin/releases/{id}/artifacts/{artifact_id}
POST   /api/admin/releases/{id}/publish    发布：status → published，写 published_at
POST   /api/admin/releases/{id}/archive    归档：不再下发；可选删除产物文件
DELETE /api/admin/releases/{id}            仅 draft 可删，同时删磁盘文件
```

`publish` 的校验是这个模块的核心防线：

1. 版本号必须比当前所有 `published` 版本都高 —— 发布一个更低的版本会让所有客户端反复收到
   「有更新」然后装回旧版；
2. `kind=updater` 的产物必须带 `signature`，否则客户端下载完必然验签失败；
3. 缺哪些平台的 updater 产物要**显式列出**并要求确认，而不是静默放过。缺 macOS 产物就意味着
   Mac 用户收到强制更新提示却无从升级；
4. `mandatory=true` 的版本发布前二次确认 —— 它会立刻把所有低版本客户端拦在登录之外。

每个操作都要写 `user_log` 审计（`app/services/audit.py`），发布是这套系统里影响面最大的
单个动作。

### 5.2 桌面端侧（无需登录）

**`GET /api/desktop/update/check?target=darwin&arch=aarch64&version=0.1.8`**（信封）

```json
{
  "code": 0, "msg": "ok", "requestId": "...",
  "data": {
    "latestVersion": "0.3.0",
    "updateAvailable": true,
    "mandatory": true,
    "mandatoryVersion": "0.2.5",
    "notes": "……",
    "publishedAt": "2026-09-02T10:00:00Z",
    "autoUpdatable": true,
    "installerUrl": "https://api.example.com/uploads/2026/09/xxx.dmg"
  }
}
```

- `mandatory`：`(当前版本, 最新版本]` 区间内存在 `mandatory=true` 的已发布版本。`mandatoryVersion`
  是其中最低的那个，用于文案（「0.2.5 起为必须更新版本」）。
- `autoUpdatable`：该 target/arch 有 `kind=updater` 产物且带签名。为 `false` 时桌面端不调
  updater 插件，直接引导用户点 `installerUrl` 手工下载 —— 对应 §3.3 的 macOS 未签名情形和
  §3.2 的 deb 安装情形。
- `updateAvailable` 必须与下面 updater 端点的判断**同源**：一处说有更新、另一处返回 204，
  用户就会卡在一个装不上的提示里。两个 handler 共用 `app/services/app_releases.py` 的同一个
  `resolve_update()`。

**`GET /api/desktop/update/{target}/{arch}/{current_version}`**（裸 JSON，Tauri 协议）

有更新时 200：

```json
{
  "version": "0.3.0",
  "notes": "……",
  "pub_date": "2026-09-02T10:00:00Z",
  "url": "https://api.example.com/uploads/2026/09/xxx.app.tar.gz",
  "signature": "dW50cnVzdGVkIGNvbW1lbnQ6…"
}
```

无更新时返回 **204 No Content**。204 已在 `app/core/api_contract.py:BODILESS_STATUSES` 里
免于包装，正好；200 的那份 JSON 需要 router 不带 `EnvelopeRoute` 才能裸返回。

两个接口都公开无认证。updater 插件在登录之前就要能检查（强制更新的意义就在于拦在登录前），
而它能泄露的只有「存在哪个版本」——安装包本身就是要发给用户的。代价是要限流：按 IP 计数，
落在这两条路径上，防止被当作带宽白拿。

## 6. 后台前端

`web/src/components/releases/` 新增：

- `releases-view.tsx` 列表：版本号、状态徽章、强制标记、四平台产物齐全度、发布时间、操作
- `release-dialog.tsx` 新建/编辑：版本号、说明、强制开关
- `release-artifacts.tsx` 产物上传：按 target × arch × kind 排成表格，每格显示已上传/缺失，
  带上传进度条
- `release-publish-dialog.tsx` 发布确认：展示 §5.1 的校验结果，缺失平台高亮

接线改动：`web/src/components/layout/sidebar.tsx` 的 `NavTab` 加 `"releases"`（图标用
`lucide-react` 的 `Rocket` 或 `PackageCheck`），`web/src/App.tsx` 的 `VALID_TABS` 同步加，
类型放 `web/src/types/app-release.ts`。

一处需要新代码而不是复用的地方：`web/src/lib/api-client.ts` 基于 `fetch`，**fetch 没有上传
进度事件**。180 MB 的上传没有进度条是不可接受的（用户会以为卡死并重试，于是同时传两份）。
所以要单独写一个基于 `XMLHttpRequest` 的 `uploadWithProgress()`，只给这个模块用，并沿用
同一套信封解析。

## 7. 大文件上传通道

现有 `POST /api/admin/uploads` 限 `VESTUS_UPLOAD_MAX_BYTES`（默认 10 MiB），
`app/core/middleware.py:UploadBodyLimitMiddleware` 按**单个**常量路径
`UPLOAD_ROUTE_PATH = "/api/admin/uploads"` 施加上限。改动：

1. 新增配置项 `VESTUS_RELEASE_MAX_BYTES`，默认 **512 MiB**（按 §3.4 的 ~200 MB 留足余量）；
2. 把中间件里的常量路径换成一个解析函数 `limit_for_path(path) -> int | None`：
   `/api/admin/uploads` → `upload_max_bytes()`，`/api/admin/releases/{id}/artifacts` →
   `release_max_bytes()`，其余 → 不限。注意该路径含数字段，匹配要用正则而不是等值比较；
3. 落盘复用 `app/core/uploads.py:store_upload()` —— 它已经是 64 KiB 分块流式写临时文件再
   `os.replace()`，本来就适合大文件；只需让上限可传入，并在同一次读取里累计 SHA-256，
   避免为了算校验和把 200 MB 再读一遍。

不做分片上传。单请求流式上传在管理员从公司网络上传的场景下够用，分片会引入会话状态、断点
续传和垃圾片清理三块复杂度。若现场实测上传经常中断，再作为独立改动加。

同时要调 Nginx（`deploy/` 下的模板）：

```nginx
client_max_body_size 512m;
proxy_request_buffering off;   # 否则 Nginx 会先把整个 200 MB 缓冲到磁盘再转发
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

## 8. 桌面端改动

### 8.1 依赖与权限

`desktop/src-tauri/Cargo.toml`：

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"   # 安装完成后重启应用
```

`desktop/src-tauri/capabilities/default.json` 的 `permissions` 加
`"updater:default"` 和 `"process:allow-restart"`。

`desktop/src-tauri/tauri.conf.json`：

```json
"plugins": {
  "updater": {
    "pubkey": "<tauri signer generate 产出的公钥>",
    "endpoints": [
      "{{API_BASE_URL}}/api/desktop/update/{{target}}/{{arch}}/{{current_version}}"
    ],
    "windows": { "installMode": "passive" }
  }
}
```

端点里的 API 地址不能硬编码：现在 `VESTUS_API_BASE_URL` 是编译期注入的
（`desktop/src-tauri/build.rs`、`auth.rs:22-25`），而 `tauri.conf.json` 不做环境变量插值。
两种走法，选后者：

- 让 `desktop/scripts/stamp-version.mjs` 顺便把 endpoints 里的占位符替换成真实地址；
- **或者**在 `lib.rs` 里用 `UpdaterExt` 的 `builder().endpoints()` 在运行时设置端点，复用
  `auth.rs` 已经写好的 `api_base_url()` 校验逻辑（它会拒绝非本机的 HTTP 地址）。

第二种更好：更新地址和登录地址不允许分叉，而 `api_base_url()` 是唯一那份校验。

### 8.2 新模块 `desktop/src-tauri/src/update.rs`

暴露两个命令，登记进 `lib.rs` 的 `invoke_handler`：

- `desktop_check_update()` → 调 `GET /api/desktop/update/check`，返回策略结果给前端。
  沿用 `auth.rs` 的 reqwest 客户端和信封解码。
- `desktop_install_update()` → `app.updater()?.check()` 拿到 `Update`，
  `update.download_and_install()`，进度通过 Tauri 事件推给前端，完成后 `process::restart()`。

**安装前必须先关掉所有浏览器会话**：

```rust
app_handle.state::<BrowserSessionManager>().shutdown();
app_handle.state::<ActivityCollector>().shutdown();
```

顺序和 `lib.rs` 退出钩子里的一致，理由也一样（浏览器先收走，调试通道才断，采集才走完最后
一次上报）。在 Windows 上还有第二个理由：Chromium 进程占着 `resources/chromium/` 里的文件，
NSIS 安装器会因文件占用直接失败。

### 8.3 前端交互

`desktop/src/` 里新增一个更新卡片，触发时机分两处：

- **启动时**（登录界面渲染后立即）：调 `desktop_check_update()`。`mandatory=true` 时覆盖整个
  界面，只留「立即更新」和「退出」，**不给「稍后」，也不让进登录**；否则显示一个可关闭的提示条。
- **登录后手动检查**：设置区放一个「检查更新」按钮，给用户主动升级的入口。

`autoUpdatable=false` 时按钮文案换成「前往下载」，用 `installerUrl` 打开系统浏览器（需要
`opener` 权限），并说明原因（「macOS 版本需手工安装」/「当前为 deb 安装，请下载新的 deb 包」）。

更新中的下载进度必须可见 —— 180 MB 在弱网下要几分钟，没有进度条的静默等待会被当成卡死。

## 9. 磁盘与留存

按 §3.4，一个版本四平台合计约 1.2–1.5 GB。策略：

- `VESTUS_RELEASE_KEEP_VERSIONS` 默认 **3**：发布新版本时，把第 4 个及更早的已发布版本自动
  转 `archived` 并删除其磁盘文件，数据库记录保留（版本历史和审计不能丢）。
- 归档版本的 `installerUrl` 失效，客户端只会被指向最新版，不影响升级路径。
- `deploy/` 的部署文档要写明上传目录的容量要求：至少 `keep_versions × 1.5 GB` 再加一倍余量。

另外要在 Nginx 里把 `/uploads/` 直接 `alias` 到上传目录（`internal` 之外的静态直供），
绕开 FastAPI 的 `FileResponse`。否则 §2.2 说的问题会发生：一次强制更新推下去，几十个客户端
同时下 180 MB，全部经 Python 进程转发，uvicorn worker 会被占满，后台和登录一起卡住。这条
不是优化，是强制更新上线的前置条件。

## 10. CI 改动

`.github/workflows/release.yml`：

1. 新增 Secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   （`tauri signer generate` 产出，私钥绝不进仓库），构建步骤注入为环境变量；
2. `tauri.macos.conf.json` 的 targets 加 `app`（§3.2）；
3. 上传到 Actions Artifacts / Release 时把 `.sig` 一起带上 —— 后台上传产物时要填签名，
   没有 `.sig` 就发布不了。

**本期不做 CI 自动登记到后台**。用户要的是「后台上传版本」，手工上传即需求本身；自动登记
需要给 CI 一个长期有效的管理员凭据，那是一条新的攻击面，等手工链路跑顺了再单独评估。

## 11. 实施顺序

| 阶段 | 内容 | 可独立验收 |
| --- | --- | --- |
| 1 | `app/core/versions.py`、两张表、迁移 `0003`、`app/services/app_releases.py` | 单元测试覆盖版本比较与强制判定 |
| 2 | 大文件上传通道（§7）+ 管理员接口（§5.1）+ Nginx 模板 | 能上传 200 MB 文件并落库 |
| 3 | 后台「版本更新」页（§6） | 可上传、发布、归档；此时已能当手工分发下载页用 |
| 4 | 两个桌面端接口（§5.2）+ 限流 | curl 能拿到 Tauri 格式 JSON 和 204 |
| 5 | 桌面端 updater 接入（§8）+ 签名密钥 + CI（§10） | Windows 与 Linux(AppImage) 端到端自动更新 |
| 6 | macOS 签名公证后开启 macOS 自动更新 | 阻塞于审计报告 F-08 |
| 7 | `docs/backend.md` 补模块说明与信封豁免、`README.md` 补发布流程、部署文档补容量 | |

阶段 1–4 是纯后端加后台，不动桌面端，可以先发布；阶段 5 才需要新的桌面端版本，而那个版本
按 §3.1 必须手工分发一次。

## 12. 验收标准

1. 后台上传四平台产物、填说明、勾强制、发布，全程有进度且失败可重试；
2. 缺 macOS updater 产物时点发布，明确列出缺失平台并要求确认，不静默通过；
3. 发布一个低于线上最高版本的版本被拒绝；
4. Windows 客户端 `0.2.0`：启动后提示 `0.2.1` 可用 → 点更新 → 浏览器会话先关闭 → 下载有进度
   → 安装 → 自动重启 → 「关于」显示 `0.2.1`；
5. 把 `0.2.1` 标为强制，`0.2.0` 客户端重启后**无法进入登录界面**，只能更新或退出；
6. 篡改测试：手工把某个产物的 `signature` 改一个字符，客户端下载后**拒绝安装**并报签名错误
   —— 这条是整套机制的安全基础，必须实测通过；
7. 无更新时 updater 端点返回 204，客户端静默不提示；
8. 归档到第 4 个旧版本时其磁盘文件被删除，数据库记录仍在；
9. 十个客户端并发下载 180 MB 期间，后台登录和列表接口响应时间不受影响（验证 §9 的 Nginx 直供）。

## 13. 明确不做

- **灰度/按用户分批推送**：与「不留旧协议客户端」的目标冲突（§2.3）。
- **多发布渠道**（stable/beta）：现在只有一条发布线，加 `channel` 列会是个没有消费者的字段。
- **增量/差分更新**：Tauri updater 不支持，需要自建 patch 分发。
- **分片续传上传**：见 §7。
- **CI 自动登记版本**：见 §10。
- **回滚到旧版本**：客户端只往前走。需要回滚时，正确做法是发一个版本号更高的修复版。

## 14. 本期之后最该做的一件事

把随包 Chromium 拆成独立版本化的资源包，与应用主体分开更新。现在每次更新 180 MB 里有 170 MB
是没变过的 Chromium；拆开后应用主体更新只有 ~15 MB。这同时解掉三个问题：用户等待时间、服务器
带宽、`VESTUS_RELEASE_KEEP_VERSIONS × 1.5 GB` 的磁盘占用。

它不在本期，是因为它要改的是 `desktop/scripts/prepare-chromium.mjs`、
`desktop/src-tauri/build.rs` 和 `browser.rs:resolve_chromium_executable()` 的资源定位逻辑，
以及首次运行的下载体验 —— 那是一条独立的、与自动更新正交的改动线。
