fn main() {
    println!("cargo:rerun-if-env-changed=VESTUS_API_BASE_URL");
    println!("cargo:rerun-if-env-changed=VESTUS_ALLOW_INSECURE_API");
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
    tauri_build::build()
}
