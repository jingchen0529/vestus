# Vestus desktop-v0.2.33 版本说明

## 发布信息
- 目标环境：dev 测试环境，不是生产环境。
- API 地址：`https://vestus-dev.quanyuos.com`
- 对比版本：`desktop-v0.2.27`（`desktop-v0.2.28`-`0.2.32` 标签的四平台构建均失败且未发布 Release，本版取代它们）

## 本次更新
- 修复托管浏览器「投放弹窗永远空白打不开」：0.2.27 及更早版本用 CDP 暂停新标签页并等待防护脚本回执后才放行，实测 Chrome for Testing 157 上 `noopener`/空 URL 弹窗的防护回执依赖放行本身，形成回执循环，弹窗停在无标题空白页且无任何报错。本版把登录页交互锁改为随包 MV3 扩展（`document_start`、`world: MAIN`、仅匹配托管平台登录 origin），在弹窗首文档执行前生效；托管启动时由桌面端按平台策略生成扩展目录并经 `--load-extension` 加载，扩展准备失败时拒绝启动并提示。
- 托管采集连接不再暂停任何新标签页；`Runtime.runIfWaitingForDebugger` 随安装批次无条件发送（实测 flatten autoAttach 会挂起新 target，与暂停开关无关），其回执只参与初始就绪闩（5 条安装回执）与后续页预算（4 条订阅回执），不再构成防护门禁。
- 初始页面保留「Cookie 注入 → 完整防护就绪 → 首次导航」顺序；CDP 注入的固定登录锁作为扩展之外的第二层兜底（幂等标记，先到者生效）。
- 防护/订阅/放行/关闭确认全部有界超时；单一标签页防护失败只关闭该标签页并核对浏览器 target 列表确认其消失，随后桌面端提示「该标签页防护初始化失败，已关闭，请重试」；无法确认清理才升级为关闭整个浏览器。意外断开的标签页同样必须验证 target 是否存活。
- 局部防护失败不修改凭据、不误报登录失效；明确退出登录与登录页稳定停留仍按既有流程销毁托管浏览器并上报原凭据版本。业务页面与弹窗的输入、点击、提交、滚动不受限制。
- 修复 0.2.28/0.2.29 标签构建失败暴露的打包校验与测试问题（两个标签均未产生发布资产）：
  - Windows：`release-assets` 脚本测试用 `script.pathname` 直接作为命令行参数，Windows 上被解析成 `C:\D:\...` 找不到模块；改用 `fileURLToPath`。
  - macOS 安装包校验：随包 Chromium 资源树比对按「目录+符号链接布局」要求逐项相等，打包器把框架符号链接落成真实文件导致误报；改为按「解析后的常规文件内容清单」比对——缺失/变更按同键同哈希判定，多余项若内容哈希存在于源清单则视为布局差异放行（新增正/负回归：链接解引用被容忍、解引用后内容被篡改仍拒绝），差异时列出具体文件，可执行身份校验保持不变。
  - Linux：`launch_refuses_an_environment_held_by_another_process` 在高负载 runner 上因进程占用扫描瞬时返回 unknown 而偶发失败（相关占用检测代码自 0.2.27 起未改动，本地多轮全绿）；测试改为对占用者存活期内的扫描结果做有界重试，不放宽拒绝语义。
  - Windows：检查器 mutation 测试的多行锚点在 CRLF 检出下不生效（0.2.29 Windows 失败原因）；`realSource` 统一归一化为 LF，与校验器自身的换行处理一致。
  - macOS（arm64 专属，0.2.30 失败原因）：arm64 上 Tauri 会给 .app 做 ad-hoc 签名，而打包器解引用框架符号链接使嵌套 Chromium 的签名 seal 失效，`codesign --verify --deep --strict` 必然失败；校验器改为记录 ad-hoc/未签名状态并附 stderr 摘要后继续（dev 环境无签名身份，真实签名与公证仍未验证），新增 arm64 形态回归。
  - Linux（0.2.30 失败原因）：安装载荷二进制经打包器 strip，逐字节与前缀判定都不成立；改用 ELF `NT_GNU_BUILD_ID` 比对（strip 与就地补丁都不影响 build-id），build-id 一致即同一构建，缺失时回退前缀判定，不一致时输出两侧哈希与 build-id 供诊断。
  - Windows：Linux 载荷校验的执行位检查在 Windows 上语义不存在导致三个用例失败；校验器的权限位检查限定 Linux 生效，对应用例加平台 skip。
  - 0.2.31 四平台再暴露的三个下一层校验问题（各平台均比上一版推进了一步）：
    - Linux：tauri 的 deb 打包用产品名而非二进制名命名桌面文件，校验器改为扫描 `usr/share/applications` 实际唯一的 `.desktop` 并核对其内容（ELF build-id 校验在 CI 实测通过）。
    - macOS arm64：`codesign --verify` 的失败改为记录 ad-hoc/未签名状态与 stderr 摘要后继续（与 0.2.31 已做的 arm64 语义配套；x86_64 路径在 0.2.31 已通过）。
    - Windows：安装前 WebView2 运行时预检在 CI runner 上必然缺失，改为记录 `webview2: absent` 后继续安装与文件校验（GUI 验证本就 not-run）。
    - macos-x86_64 的 Upload artifacts 因 GitHub 瞬时 ETIMEDOUT 失败，非代码问题，重跑即可。
  - 0.2.32 四平台再暴露的两个问题（macOS 双架构本轮已全部通过）：
    - Linux：AppImage 根目录的 `Vestus.desktop` 是指向 `usr/share/applications` 的符号链接，`checkDesktop` 的 lstat 拒绝链接；改为 realpath 解析后校验常规文件。
    - Windows：安装后的主程序哈希与当前构建不一致（NSIS 安装器对二进制的处理待查），校验错误补充两侧哈希与字节数供下一轮定位。
  - Linux 安装包校验：Tauri 打 AppImage 时会就地给 release 二进制追加 bundle type 信息（CI 日志 `Patching ... with bundle type information: appimage` 实证），deb 里的二进制是补丁前的原始文件，逐字节比对必然失败；改为「相同或为当前构建的前缀」判定（AppImage 载荷仍要求逐字节相等），不一致时输出两侧哈希供诊断，并新增前缀容忍与篡改拒绝回归。
- 发布流水线硬化（随版工程改动）：`Release` 增加说明文件与后端 API 预检 job、四平台原生准备 Chromium、并发组不取消进行中的发布、手动触发必须指定版本且只产 Artifacts；新增安装包核验脚本（Windows/macOS/Linux）与发布资产脚本及回归；新增手动触发的浏览器回归工作流；macOS 打包目标在 dmg 之外新增 app 目录；固定桌面 Rust 工具链版本。
- 新增仓库社区与文档文件（CONTRIBUTING/SECURITY/dependabot/PR 模板等）并更新 README 与部署文档；Web 端声明 pnpm 版本与 Node 最低版本。

## 安装与升级
- Windows x86_64、macOS Apple Silicon / Intel、Linux x86_64 安装包计划由 `desktop-v0.2.33` 标签构建产生。
- 升级前建议退出旧 Vestus 客户端。已有浏览器 profile 和登录状态按当前兼容策略保留；托管临时 profile 生命周期不变。
- macOS 签名公证、Windows 实机安装和 Linux 安装未验证。

## 后端配套
- 沿用 `desktop-v0.2.27` 的接口和 API 地址。
- 本版不新增数据库迁移，不部署后端，不更新服务器。

## 验证结果
- 0.2.28 发布前完成的两轮同口径回归对本版浏览器链路仍然有效（0.2.29/0.2.30 只改打包校验与测试，不改浏览器生产代码）：检查器套件 101 项 ×2、控制门禁 harness 28 项 ×2、四项真实浏览器门禁 ×2 全过（含 noopener 弹窗用例）、`check:surfaces` ×2。
- 打包校验修复后的本地回归：`npm --prefix desktop test` 357 项通过、0 项失败、1 项按平台 skip（`verify-installers` 14 项全过）；检查器套件 101 项通过；控制门禁 harness 28 项通过；`git diff --check` 通过。
- 0.2.28/0.2.29 两次 CI 失败的原始日志已归档核对：macOS `extra(1)` 为框架符号链接解引用（本版已容忍）；Linux 错误来自 AppImage 就地补丁（本版已前缀容忍）；Windows 为 CRLF 锚点（本版已归一化）。
- GitHub Actions 四平台构建、安装包签名公证、GitHub Release、Windows 实机 `--load-extension` 行为、真实方舟投放页、客户真实 VPN 与生产 API：未验证。

## 已知限制
- `--load-extension` 在 Chrome for Testing 137+ 品牌构建上已被移除；CfT 是否长期保留该开关、以及 Windows 实机行为未验证。后续升级随包 Chromium 时需重新确认。
- unpacked 扩展可能触发开发者模式相关 UI 提示；macOS 实测无扩展加载报错，但提示条 UI 未做截图级验证。
- 随包扩展可被本机用户禁用，登录锁与 CDP 注入同为最佳努力防护，不构成对抗本机用户的隔离边界。
- 代理或第三方 CDN 响应缓慢时，目标页面首屏加载仍可能较慢。
- Linux 占用扫描在高负载 runner 上仍可能瞬时 unknown：生产语义保持「未知状态不拒绝启动、失败防护仍强制清理」，测试已做有界重试。
- arm64 .app 的 ad-hoc 签名在打包器解引用后无效，校验器按未签名记录；生产签名与公证流程仍未验证。
- 本说明对应 `desktop-v0.2.33`，提交、标签推送和四平台构建尚未执行。
