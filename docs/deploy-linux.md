# Linux 生产部署

本方案面向 Ubuntu 22.04/24.04：Nginx 对外提供 HTTPS，Uvicorn 仅监听
`127.0.0.1:8000`，MySQL 保存业务数据，上传文件持久化到
`/var/lib/vestus/uploads`。Linux 服务器只部署 Python API 和 React 管理端；
Tauri 桌面客户端由 GitHub Release 单独分发。

## 1. 准备环境

安装 Git、Python 3.10+（含 `venv`）、Node.js 20/22、Nginx 和 MySQL 8，并确认：

```bash
python3 --version
node --version
npm --version
nginx -v
mysql --version
```

创建无登录权限的服务账号和持久目录：

```bash
sudo useradd --system --create-home --home-dir /opt/vestus --shell /usr/sbin/nologin vestus
sudo install -d -o vestus -g vestus -m 0755 /opt/vestus
sudo install -d -o vestus -g vestus -m 0750 /var/lib/vestus/uploads
sudo install -d -o root -g vestus -m 0750 /etc/vestus
```

`/opt/vestus` 使用 0755 仅为运维账号提供源码目录的读取/穿越权限，写权限仍只属于
`vestus`；数据库口令与密钥始终放在 0750 的 `/etc/vestus`，不要写入源码目录。

首次部署时，将仓库检出到 `/opt/vestus/current`。下面的命令统一使用 `-H`，确保 Git、
npm 和缓存都读取 `/opt/vestus` 下的服务账号环境。私有仓库应给 `vestus` 配置只读
Deploy Key；更安全的方式是由 CI/独立部署账号同步代码，让运行账号不持有仓库凭据：

```bash
sudo -H -u vestus git clone <repository-url> /opt/vestus/current
```

## 2. 创建 MySQL 数据库

生产环境不要使用空密码或 root 账号。先进入 MySQL：

```bash
sudo mysql
```

再创建独立数据库和账号；将示例密码替换为强随机密码：

```sql
CREATE DATABASE `vestus` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'vestus'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT ALL PRIVILEGES ON `vestus`.* TO 'vestus'@'127.0.0.1';
FLUSH PRIVILEGES;
```

确认 MySQL 的 `bind-address` 为 `127.0.0.1`，并用 `sudo ss -ltnp | grep ':3306'`
验证 3306 没有监听公网地址。防火墙只开放管理所需的 SSH 以及 Nginx 的 80/443；启用
防火墙前务必先放行当前 SSH 端口，避免把自己锁在服务器外。

只创建空数据库，不要为全新安装导入旧版本的 `schema.sql`。后面的
`init_db.py` 会按当前 ORM 创建表。已有数据库升级时，`create_all()` 不会修改旧表，
必须先备份并执行仓库内的版本迁移，再重启服务。本版本迁移可重复执行：

```bash
cd /opt/vestus/current
sudo mysql vestus < deploy/migrations/2026-08-27-settings-and-uploads.sql
```

该迁移会补齐 `platform.icon_url`、`proxy.bypass_hosts`、`system_setting` 和
`uploaded_file`；使用远程 MySQL 时，请改用具备对应库 `ALTER`/`CREATE` 权限的迁移账号。

## 3. 安装依赖并构建管理端

```bash
cd /opt/vestus/current
sudo -H -u vestus python3 -m venv .venv
sudo -H -u vestus .venv/bin/python -m pip install --upgrade pip
sudo -H -u vestus .venv/bin/python -m pip install -r requirements.txt
sudo -H -u vestus npm --prefix web ci
sudo -H -u vestus npm --prefix web run build
```

必须先生成 `web/dist` 再启动或重启 Uvicorn；后端会在进程启动时注册该目录下的
静态资源。

## 4. 配置生产环境变量

用 `openssl rand -hex 32` 分别生成两个长期稳定、彼此不同的密钥。然后执行
`sudoedit /etc/vestus/vestus.env`，写入：

```dotenv
VESTUS_DATABASE_URL=mysql+pymysql://vestus:URL_ENCODED_PASSWORD@127.0.0.1:3306/vestus?charset=utf8mb4
VESTUS_SQLITE_FALLBACK=0
VESTUS_SECRET_KEY=replace-with-a-stable-random-secret
VESTUS_PROXY_SECRET_KEY=replace-with-another-stable-random-secret
VESTUS_ACCESS_TOKEN_TTL_SECONDS=900
VESTUS_COOKIE_SECURE=1
VESTUS_TRUST_PROXY=1
VESTUS_CORS_ORIGINS=https://admin.example.com
VESTUS_PRODUCT_NAME=Vestus
VESTUS_UPLOAD_DIR=/var/lib/vestus/uploads
VESTUS_UPLOAD_MAX_BYTES=10485760

# 仅首次初始化保留下面两项；创建管理员后立即删除密码并重启服务。
VESTUS_BOOTSTRAP_ADMIN_USERNAME=admin
VESTUS_BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-strong-one-time-password
```

MySQL 密码中的 `@`、`:`、`/`、`#` 等保留字符必须进行 URL 编码。两个密钥都不能在
服务重启时变化：改变 `VESTUS_SECRET_KEY` 会使现有登录失效；未经迁移直接改变
`VESTUS_PROXY_SECRET_KEY` 会导致数据库中已有代理密码无法解密。

保护配置文件：

```bash
sudo chown root:vestus /etc/vestus/vestus.env
sudo chmod 0640 /etc/vestus/vestus.env
```

`.env`、数据库文件、上传目录和密钥都已被 Git 忽略，不要强制加入仓库。

## 5. 启用 systemd 服务

仓库提供的模板默认使用上述目录：

```bash
sudo cp /opt/vestus/current/deploy/vestus.service.example /etc/systemd/system/vestus.service
sudo systemctl daemon-reload
sudo systemctl enable --now vestus
sudo systemctl status vestus --no-pager
sudo journalctl -u vestus -n 100 --no-pager
```

服务启动前会运行 `init_db.py`，数据库不可用时直接失败；Uvicorn 只启用一个 worker，
避免多进程同时执行建表和首个管理员引导。首次创建管理员后，从环境文件删除
`VESTUS_BOOTSTRAP_ADMIN_PASSWORD`，再执行 `sudo systemctl restart vestus`。

检查数据库健康状态。`/healthz` 即使降级也返回 HTTP 200，因此必须校验 JSON 内容：

```bash
curl -fsS http://127.0.0.1:8000/healthz \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "ok"'
```

## 6. 配置 Nginx 和 HTTPS

先把域名 A/AAAA 记录指向服务器并取得 TLS 证书。复制模板后，将其中所有
`admin.example.com` 和证书路径替换成真实值：

```bash
sudo cp /opt/vestus/current/deploy/nginx-vestus.conf.example /etc/nginx/sites-available/vestus
sudoedit /etc/nginx/sites-available/vestus
sudo ln -s /etc/nginx/sites-available/vestus /etc/nginx/sites-enabled/vestus
sudo nginx -t
sudo systemctl reload nginx
```

模板覆盖客户端传入的 `X-Forwarded-For`，只把 Nginx 看到的来源地址交给应用，
并拒绝未知 Host。这样上传接口返回的完整 URL 会使用当前系统真实的 HTTPS 域名，
数据库仍只保存 `/uploads/YYYY/MM/...` 相对路径。

模板没有声明 `default_server`，可与 Ubuntu 自带默认站点共存，不会造成重复默认服务配置。
确认不再需要系统欢迎页后，可单独移除 `/etc/nginx/sites-enabled/default`；不要删除其他业务站点。

默认应用文件上限为 10 MiB，Nginx 模板使用 `client_max_body_size 11m` 预留 multipart
开销。修改 `VESTUS_UPLOAD_MAX_BYTES` 时必须同步调整 Nginx 限制。

## 7. 更新、备份与恢复

更新前同时备份数据库、上传目录和受保护的环境文件，保证三者属于同一恢复点。
环境文件中的 `VESTUS_PROXY_SECRET_KEY` 不可替代；丢失后，数据库中已有代理密码将永久
无法解密。以下命令在 root-only 目录中创建权限为 0600 的本机备份：

```bash
sudo -i
umask 077
vestus_backup_dir="/var/backups/vestus/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$vestus_backup_dir"
mysqldump --single-transaction --routines --triggers --no-tablespaces vestus \
  > "$vestus_backup_dir/vestus.sql"
tar -C /var/lib/vestus -czf "$vestus_backup_dir/vestus-uploads.tar.gz" uploads
install -m 0600 /etc/vestus/vestus.env "$vestus_backup_dir/vestus.env"
exit
```

本机备份仍不能代替灾难恢复：应将整个恢复点加密后复制到受访问控制的异机存储或密钥
保险库，并定期验证恢复。不要把 `vestus.env` 上传到 Git 或未加密的对象存储。

当前目录原地部署时，先停止服务，避免 Vite 清空 `web/dist` 或依赖更新期间产生版本错配：

```bash
sudo systemctl stop vestus
cd /opt/vestus/current
sudo -H -u vestus git pull --ff-only origin main
sudo mysql vestus < deploy/migrations/2026-08-27-settings-and-uploads.sql
sudo -H -u vestus .venv/bin/python -m pip install -r requirements.txt
sudo -H -u vestus npm --prefix web ci
sudo -H -u vestus npm --prefix web run build
sudo systemctl start vestus
curl -fsS http://127.0.0.1:8000/healthz \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "ok"'
```

恢复时先停止 `vestus`，恢复同一次备份中的 MySQL 数据、`/var/lib/vestus/uploads` 和
`/etc/vestus/vestus.env`，校正上传目录所有者为 `vestus:vestus`、环境文件权限为
`root:vestus 0640` 后再启动。不要只恢复其中一项，否则数据库记录、磁盘文件和加密密钥会
失去对应关系。
