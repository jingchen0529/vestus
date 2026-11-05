fn main() {
    println!("cargo:rerun-if-env-changed=VESTUS_API_BASE_URL");
    println!("cargo:rerun-if-env-changed=VESTUS_ALLOW_INSECURE_API");
    export_client_version();
    // Playwright 没有 Windows on ARM 的 Chromium 构建，随包浏览器会缺失。
    // macOS(arm64/x86_64) 与 Linux(x86_64) 由各自 runner 原生打包，都有产物。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("x86_64")
    {
        panic!("Windows 随包 Chromium 仅支持 x86_64");
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let api = std::env::var("VESTUS_API_BASE_URL").unwrap_or_default();
        if !api.trim().starts_with("https://") {
            // 打包流水线还没有正式 HTTPS 域名时用这个开关换一条明确的警告。
            // 正式发布不要设置它：明文 HTTP 会把登录口令和令牌暴露在网络上。
            if std::env::var("VESTUS_ALLOW_INSECURE_API").as_deref() == Ok("1") {
                println!(
                    "cargo:warning=VESTUS_API_BASE_URL 不是 https://（{api}）：此包仅供验证打包流水线，不要分发"
                );
            } else {
                panic!(
                    "release 构建必须设置 VESTUS_API_BASE_URL=https://...（仅验证打包时可用 VESTUS_ALLOW_INSECURE_API=1 放行）"
                );
            }
        }
    }
    // Tauri CLI 调 cargo 前仍会往环境塞废弃的 STATIC_VCRUNTIME，tauri-build 2.7+
    // 见到就打迁移警告。这里读出 CLI 的取值后移除该变量，改用显式属性传同样的
    // 语义：CLI 传 true 时 Windows 静态链接 VC 运行库（安装包无需用户另装 VC++
    // Redistributable，与既有发布包一致）；CLI 没传（本地/测试直接跑 cargo）时
    // 保持 tauri-build 原默认的动态链接，两条路径行为都不变。
    let static_vc_runtime = std::env::var("STATIC_VCRUNTIME")
        .map(|value| value != "false")
        .unwrap_or(false);
    std::env::remove_var("STATIC_VCRUNTIME");
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new().static_vc_runtime(static_vc_runtime),
    ))
    .expect("tauri build 失败")
}

/// 把安装包的版本号导出成 `VESTUS_CLIENT_VERSION`，供活动上报使用。
///
/// 桌面版本号只有 `tauri.conf.json` 这一个来源：发布流水线只把标签里的版本写进
/// 那个文件（见 `desktop/scripts/stamp-version.mjs`），`Cargo.toml` 的 `version`
/// 故意不动，免得连带 `Cargo.lock` 变更影响构建缓存。于是 `CARGO_PKG_VERSION`
/// 会一直停在初版号，拿它上报等于每个版本都报同一个数字。
///
/// 读不到就直接失败：一个静默的错版本号比构建失败难查得多，而 `tauri_build`
/// 本身也需要这个文件，缺了它无论如何都打不出包。
fn export_client_version() {
    const CONFIG: &str = "tauri.conf.json";
    println!("cargo:rerun-if-changed={CONFIG}");
    let raw =
        std::fs::read_to_string(CONFIG).unwrap_or_else(|err| panic!("读不到 {CONFIG}：{err}"));
    let config: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|err| panic!("{CONFIG} 不是合法 JSON：{err}"));
    let version = config
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("{CONFIG} 缺少字符串字段 version"));
    println!("cargo:rustc-env=VESTUS_CLIENT_VERSION={version}");
}
