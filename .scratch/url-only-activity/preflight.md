# URL-only 交付前剩余性能与稳定性检查

日期：2026-11-16

状态：本地补充验证完成；不建议以当前本地通过结果替代客户 Windows 安装包的发放前验收。

本轮未修改产品实现、发布流水线或随包浏览器，只新增分析与本地合成实验结果。原有URL-only工作区改动保留。

## 结论

没有进一步确诊客户素材选择冻结的单一原因。已经去掉的表单/交互采集不再是新版本路径；本轮测试也未发现固定guard在合成素材页面导致冻结或JS/DOM持续增长。

仍有三类交付风险：

1. **验证缺口：Windows真实浏览器持久化门禁可失败继续发布**。不能把CI构建绿色当作Windows浏览器完整链路通过。
2. **内核选择缺陷：准备脚本按缓存目录mtime取浏览器**，没有核对预期revision/version/architecture。Playwright版本固定不等于最后复制的Chromium身份固定。
3. **负载与异常硬化不足：** 原生视频/GPU/内存、多保留浏览器进程、无界连接/事件队列，以及CDP故障时的暂停/放行验证。源码确认风险，客户是否触发未验证。

## 本轮执行的压力验证

在全新临时目录生成2秒320×180、15fps VP9 WebM，不使用客户素材或外部网站。用随包Chrome153.0.8010.12，macOS arm64，headless新profile。Page-only订阅，无Runtime.enable/binding；固定guard仅将origin换为localhost，除此之外不修改。

每轮4种组合：图片/图片+24个视频预览，guard关/开。每种6次创建及清空素材区，每次1000卡片、勾选200项，共2轮48循环、9600次原生checkbox激活。每次结束用Input.dispatchMouseEvent发送真实浏览器输入协议事件，验证页面仍响应。

结果：

- 两轮全部完成，脚本退出0；9600选择与48次输入断言通过。
- 视频场景每循环24/24视频play成功且达到readyState>=2。
- 20次勾选一批的页面脚本耗时最大约0.6ms；这不是含绘制的INP。
- PerformanceObserver观察到的>50ms长任务为0；不是全链路没有尾延迟的证明。
- 清空后显式HeapProfiler GC：每种组合第二轮与第一轮相同，DOM节点11，JS堆约0.54–0.61MB。
- Chromium进程ID列表对应的合计RSS约1.3–1.6GB波动；没有在本轮短测中证明持续泄漏，也没有证明原生内存可忽略。
- 图片使用相同小SVG且lazy加载，视频是小分辨率合成片段。不能代表1000张不同高分辨率图片、真实1080p/4K视频、长时间使用或客户Windows/GPU。测试脚本主动释放预览资源，第三方平台是否正确释放未验证。
- pointerDispatchMs包含后续metrics、进程查询及ps测量时间，不应当作纯鼠标事件延迟。

脚本：`preflight-evidence/material-stress.mjs`。原始JSON：`preflight-evidence/material-stress-results.json`。

命令：

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=320x180:rate=15' -t 2 -an -c:v libvpx-vp9 -b:v 150k /tmp/vestus-preflight.YMfCaU/preview.webm
node /tmp/vestus-preflight.YMfCaU/material-stress.mjs '<随包Chromium>' desktop/src-tauri/src/managed_cdp/login_guard.js /tmp/vestus-preflight.YMfCaU
```

## 生命周期补测

显式执行已有隔离真实Chromium测试，两轮均1通过、0失败、0忽略，退出0：

```sh
VESTUS_TEST_CHROMIUM_PATH='<随包Chromium>' cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --lib browser::lifecycle_tests::real_headless_chromium_force_kill_and_rapid_reopen -- --ignored --exact --test-threads=1
```

确认强制关闭整个拥有的进程树、清理临时managed profile、释放租约、快速重开。每轮2次launch；该测试Unix/headless并带disable-gpu，不能代表Windows视频/渲染长稳。完整输出：`preflight-evidence/lifecycle-two-rounds.log`。

## 新确认的发包前问题

### 1. Windows持久化测试被允许失败

`.github/workflows/release.yml:203-209` 的Windows persistence门禁设置continue-on-error，注释明确写着Windows本地fixture导航停留about:blank且此前未验证通过。真实control门禁当前强制执行，但不等于安装权限、真实Cookie加密、重启持久性、长时素材操作全部通过。

**建议发放条件：** 开发/QA自己的Windows机器或受控Windows runner，对准备发出的确切安装包做首次安装/启动、托管、图片/视频选择、重启和退出验收；先定位既有失败，再取消放行例外。不能直接让长期已失败测试阻断却不解决，也不能继续把失败算通过。无需把首轮验收转交客户。

当前本地环境macOS，没有可用已授权Windows测试机或客户Windows安装包的运行结果；此项明确未验证。

### 2. 浏览器准备的缓存选择不确定

`desktop/scripts/prepare-chromium.mjs:29-30`固定Playwright1.63.0；`:82-94`将全部chromium-*缓存按mtime排序，取第一个可用布局，没有校验所需revision/browserVersion/architecture。缓存目录被触碰或存在其他revision时，可能复制错内核。

本地文件是Chrome for Testing153.0.8010.12；不能由Playwright版本或CfT名推断它是Stable。`install chromium`不是指定标准Chrome stable channel。项目目前有意保留CfT，不能未经兼容验证改成系统Chrome/Edge。

**建议修复：** 使用已指定Playwright发行版的浏览器manifest确定revision和目标架构，只取精确目录；复制前后校验实际内核身份，记录在构建/验证结果与发布说明，缺失或不匹配即失败。新增混杂缓存/错误架构/缺少revision负例。不要在诊断时自动升级浏览器，避免新增变量。

### 3. 视频与多浏览器原生资源风险

浏览器数没有全局上限，不同平台/账号/模式可分别保留Chromium树；同环境复用并非重复点击泄漏。当前本地合成测试的整体RSS已明显高于JS堆，因此只看JS快照不能排除解码、纹理、GPU或多进程内存压力。

**建议验证：** 同一候选Windows包，在图片和实际规模的合成视频预览下连续运行，测整棵Chromium的内存/GPU/磁盘趋势、窗口数与关闭后的回收；正常硬件加速与硬件视频解码禁用只做单变量对照，证据成立后再考虑可回滚兼容模式。不能默认禁GPU、关闭沙箱或清用户profile。

生产Chromium stderr目前丢弃，原生崩溃/挂起证据不足。若增加诊断应只包含进程资源、关闭原因、内核版本和耗时，不读取Cookie/表单/未经脱敏URL或完整日志。

## CDP与代理剩余硬化点

- collector用同一websocket顺序发送/读取；安装/放行请求多数只发命令不检查对应回执。缺回执不会让代码逐条等待，但backpressure/transport卡住可能停止处理后续target；连接握手和collector写缺少独立截止时间。
- 托管通道错误会发ConnectionLost，生产消费者确认仍运行后关闭浏览器，这是安全收敛，不是证明页面冻住。普通模式故障是否能保证新target继续运行，须真实fault矩阵验证，不能靠resume命令列表推断。
- 本轮尝试了独立CDP disconnect/detach实验，但6个场景在操作前页面标记已进展，暂停前置条件不成立。故结果**不用于证明异常断线会自动放行或不会冻结**；脚本退出0不等于该验收通过。
- 地址事件unbounded channel、session/frame请求图、每proxy连接task及无idle tunnel截止时间是源码确认的无界路径。URL-only下素材勾选本身不入队；是否资源耗尽未验证。增加上限必须保留导航/长连接及安全路由语义，不盲目截断视频请求。
- 直连IP逐个连接每个可等10秒；某CDN/接口可造成网络pending，但普通网络等待通常不能解释整个Windows鼠标冻结。
- reader优先避免误报取消后的超时，但持续就绪事件可能延迟deadline；不存在Runtime高频订阅，不代表异常Page事件洪泛已覆盖。
- 固定guard保留业务页MutationObserver，但仅做路由检查、不遍历DOM。当前变更大量元素的压力测试未发现循环；若平台自己反复覆盖登录根节点样式，竞争循环和/login子路由误匹配仍需真实平台证据。

## 发放建议

**本次建议继续暂缓把本地测试通过直接等同于客户可用：**

1. 修复内核身份选择/记录，确保候选包与验证包一致。
2. 开发端完成候选包的Windows有窗口长稳素材测试与既有持久化失败定位，作为发包门禁；不交客户首验。
3. 为CDP异常安装/放行建立真实故障矩阵和有限等待/安全收尾方案，先验证现有行为再改。根据证据选择最小修复，不盲加参数。
4. 保留URL-only已有两轮功能门禁，优化/修复后同口径复测再发。

以上建议不是已经实施的新产品修复。本轮仅分析+实验，没有提交、打包、发布、对外发送或读取真实账号。`git diff --check`通过。客户根因和Windows验收仍未验证，不能承诺零卡顿。
