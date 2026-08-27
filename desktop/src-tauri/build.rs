fn main() {
    println!("cargo:rerun-if-env-changed=VESTUS_API_BASE_URL");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("x86_64")
    {
        panic!("当前随包 Chromium 仅支持 Windows x86_64");
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let api = std::env::var("VESTUS_API_BASE_URL").unwrap_or_default();
        if !api.trim().starts_with("https://") {
            panic!("release 构建必须设置 VESTUS_API_BASE_URL=https://...");
        }
    }
    tauri_build::build()
}
