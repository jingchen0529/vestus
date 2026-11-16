# CfT Stable 157 升级验证

日期：2026-11-16。状态：本机随包内核与准备脚本已更新，最终两轮验证通过。

## 版本与文件

- 目标/实际本机内核：Chrome for Testing Stable **157.0.8103.78**，revision **1717349**，mac-arm64。
- Live资源：`desktop/src-tauri/resources/chromium/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`。
- 身份记录：`desktop/src-tauri/resources/chromium/chromium-identity.json`。
- 可执行SHA256：`0dc5fa1ed2364c0e4b80da73cb61a1230c57f052e18199807f0110fefce6de2d`。
- 旧153完整备份：`desktop/.cache/chromium-backups/chromium-1794810021325-133fcf8b-956c-48b3-aafc-981a4f20a8c9`；旧Info.plist实际版本仍为153.0.8010.12。
- 应用版本未stamp、未commit/push、未打包/发布。客户已安装程序不受本机资源替换影响。

## 改动

- `desktop/scripts/prepare-chromium.mjs` 固定目标版本/revision及官方元数据路径，按四个已支持OS/arch组合精确下载，不使用Playwright缓存mtime。
- 新 `chromium-archive.mjs` 校验ZIP路径/链接与解压树；校验MacMachO、WindowsPE、LinuxELF架构和native版本。
- 候选/归档/解压/命令目录隔离，candidate与backup在包装资源之外、同文件系统；候选校验后rename，失败恢复；保留旧备份及.gitkeep。
- 新 `prepare-chromium.test.mjs` 提供离线选择、拒绝错误元数据/架构/归档、无副作用import、失败恢复测试。
- README更新准确内核版本和prepare行为。已有URL-only实现的cdp/activity/managed源码SHA256前后相同。

## 下载与安装证据

Google官方精确版本JSON返回157.0.8103.78/rev1717349、四平台URL；macarm64archiveHTTP200、196634479字节，MD5 `bfb25fb3f672c4f2fb236acab8f5521b`与官方HEAD一致。ZIP CRC/path/symlink预检通过（673条目），实际archive也通过新的Node检查。解压native文件为Mach-O arm64；Info.plist=157.0.8103.78。

下载目录`/tmp/vestus-cft157-download.Ch36gM`；解压`/tmp/vestus-cft157-extracted.DBTT7Y`，脚本`/tmp/vestus-cft157-scripts.z01kGC`。脚本不在归档内执行，没有读取真实用户profile。旧资源在确认candidate真实浏览器测试通过后替换。

调用新export `prepareChromium({fetchImpl})` 完整执行实际安装；fetchImpl仅为已校验本地官方ZIP供给相同URL响应，元数据仍实时官方获取，避免重复196MB下载。安装退出0，native版本/arch/SHA身份与备份路径校验通过。

## 实际验证

- 新candidate执行真实control两轮：每轮2通过/0失败/0忽略，74.56s/72.44s；地址初始/nav/SPA/iframe过滤/popup/newtab及托管防护、61秒无交互报告通过。
- candidate强制结束树/快速重开门禁两轮：各1通过/0失败/0忽略，临时profile清理/lease通过。Unix/headless且该测试禁GPU，不替代WindowsGPU验证。
- candidate素材压力两轮：8组合、48循环，每次1000卡片/200checkbox，共9600选择；24视频预览均play/ready。Browser.getVersion所有组合实际为Chrome/157.0.8103.78；0观测长任务；20选择一批最高0.8ms（不含完整绘制，不是INP）；显式GC后DOM节点11。
- 新live位置验证门禁两轮：各2通过/0失败/0忽略，74.02s/72.78s，整个命令退出0。
- 桌面Node/tsc+vite/surfaces最终两轮：各169通过/0失败，build/安全边界通过；最后官方ZIP与live内核重新校验通过。
- preparation离线测试最终两轮各12通过；node语法与git diff检查通过。

## 命令

```sh
node --test desktop/scripts/prepare-chromium.test.mjs
npm --prefix desktop test
npm --prefix desktop run build
npm --prefix desktop run check:surfaces
VESTUS_CONTROL_CHROMIUM='<candidate或live绝对路径>' npm --prefix desktop run test:control
VESTUS_TEST_CHROMIUM_PATH='<candidate绝对路径>' cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --lib browser::lifecycle_tests::real_headless_chromium_force_kill_and_rapid_reopen -- --ignored --exact --test-threads=1
```

## 失败与限制

- 最早stress因旧测试页面就绪检查/命名DOM隐式全局引用 `toggle` 未定义而失败；改为明确检查DOMready及getElementById。随后临时脚本引号错误SyntaxError修正，最终同口径两轮通过。未改产品逻辑以绕过问题。
- ZIP本地extra字段校验和backupRoot符号链接真实路径检查经审查发现，已先失败后修复；两个ZIP目录共享校验，backup真实路径检查及cleanup负例，两轮12测试通过，复审没有剩余阻断。官方archive以独立PythonCRC/路径/link检查及最终Node实际校验通过。异常回滚失败本身和进程在两次rename间被强杀仍未覆盖，不承诺原子跨进程崩溃恢复。
- 本机仅macARM64实际下载/运行。Windows/Linux/macIntel仅配置/离线fixture验证，真实Windows素材选择、GPU/驱动、安装权限、持久化链路仍未验证。升级可能改善兼容性，但不能承诺已解决客户卡死。
- 不自动启用/禁用GPU、不关闭沙箱、不改代理或SQLite、不清真实profile。旧binary备份不保证任意旧profile安全跨版本降级；profile回滚另行隔离验证。
- 生产版本打包需另按AGENTS发布说明审核流程。此轮未改发布tag或启动远端CI。
