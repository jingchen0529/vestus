//! Local-only managed watch uses the production fixed guard and monitor. No
//! bootstrap credentials or real platform/network/profile are used by acceptance.
use super::*;

const MANAGED_PLATFORM_URL: &str = "https://agent.oceanengine.com/workbench";

fn scratch_dir(label: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "vestus-managed-cdp-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir(&root).unwrap();
    root
}

pub(super) fn localhost_watch(
    base_url: &str,
    signals: tokio::sync::mpsc::UnboundedSender<crate::cdp::ManagedSignal>,
) -> crate::cdp::ManagedWatch {
    let base = Url::parse(base_url).unwrap();
    assert_eq!(base.scheme(), "http");
    assert_eq!(base.host_str(), Some("127.0.0.1"));
    let policy = LogoutPolicy {
        endpoint: base.join("logout").unwrap(),
        login_route: base.join("login").unwrap(),
    };
    let monitor = ManagedSessionMonitor {
        detector: LogoutDetector::new(policy.clone()),
        notified: false,
        status: LoginGuardStatusView::default(),
    };
    let status = monitor.status_view();
    crate::cdp::ManagedWatch {
        login_guard_script: policy.login_guard_script(),
        monitor,
        signals,
        status,
        guard_installed: GuardInstalled::default(),
    }
}

/// 按生产 [`write_login_guard_extension`] 的同一模板与 manifest 形状，为测试
/// fixture 的 loopback origin 生成预装 MV3 登录防护扩展，返回扩展目录。
///
/// 生产函数按平台策略只接受 agent.oceanengine.com（本地 fixture 目标会被
/// fail-closed 拒绝），所以本 helper 用 [`localhost_watch`] 同款测试策略
/// （同源 /logout + /login 路由）驱动同一份 `login_guard.js` 模板——JS 只此一份，
/// 绝不内联复制；manifest 字段与生产逐项一致，仅 origin 换成 fixture。
#[cfg(test)]
pub(crate) fn write_login_guard_extension_for_test(
    dir: &std::path::Path,
    base: &str,
) -> std::path::PathBuf {
    let base = Url::parse(base).unwrap();
    let policy = LogoutPolicy {
        endpoint: base.join("logout").unwrap(),
        login_route: base.join("login").unwrap(),
    };
    let extension_dir = dir.join("vestus-login-guard-extension");
    std::fs::create_dir_all(&extension_dir).unwrap();
    let origin = policy.login_route.origin().ascii_serialization();
    let manifest = json!({
        "manifest_version": 3,
        "name": "Vestus 登录防护",
        "version": "1.0.0",
        "content_scripts": [{
            "js": ["guard.js"],
            "matches": [format!("{origin}/*")],
            "run_at": "document_start",
            "all_frames": false,
            "world": "MAIN",
        }],
    });
    std::fs::write(extension_dir.join("manifest.json"), manifest.to_string()).unwrap();
    std::fs::write(extension_dir.join("guard.js"), policy.login_guard_script()).unwrap();
    extension_dir
}

/// 测试版扩展生成必须与生产形状逐项一致（仅 origin 换成 fixture），且
/// guard.js 就是同一模板的产物：带标记、route JSON 指向 fixture 的 /login。
#[test]
fn login_guard_extension_for_test_mirrors_the_production_shape() {
    let root = scratch_dir("extension-for-test");
    let base = "http://127.0.0.1:19001/";
    let path = write_login_guard_extension_for_test(&root, base);
    assert_eq!(path, root.join("vestus-login-guard-extension"));
    assert!(path.is_dir());
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["manifest_version"], 3);
    assert_eq!(manifest["name"], "Vestus 登录防护");
    assert_eq!(manifest["version"], "1.0.0");
    let scripts = manifest["content_scripts"].as_array().unwrap();
    assert_eq!(scripts.len(), 1);
    assert_eq!(scripts[0]["js"], serde_json::json!(["guard.js"]));
    assert_eq!(
        scripts[0]["matches"],
        serde_json::json!(["http://127.0.0.1:19001/*"])
    );
    assert_eq!(scripts[0]["run_at"], "document_start");
    assert_eq!(scripts[0]["all_frames"], false);
    assert_eq!(scripts[0]["world"], "MAIN");
    let guard = std::fs::read_to_string(path.join("guard.js")).unwrap();
    assert!(guard.contains("__vestusManagedLoginGuard"));
    assert!(guard.contains("\"origin\":\"http://127.0.0.1:19001\""));
    assert!(guard.contains("\"path\":\"/login\""));
    assert!(
        !guard.contains("__VESTUS_LOGIN_ROUTE__"),
        "route placeholder must be substituted"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// 托管启动的预装扩展必须落在 profile 目录里：它随托管清理一起消失，
/// 绝不能写到 profile 之外。
#[test]
fn login_guard_extension_is_generated_under_the_profile_directory() {
    let root = scratch_dir("extension");
    let path = write_login_guard_extension(&root, MANAGED_PLATFORM_URL).unwrap();
    assert_eq!(path, root.join("vestus-login-guard-extension"));
    assert!(path.starts_with(&root));
    assert!(path.is_dir());
    let _ = std::fs::remove_dir_all(root);
}

/// manifest 必须钉住 document_start + MAIN 世界：隔离世界内联注入在 CfT 157
/// 已不执行，只有 MAIN 世界 content script 能赢得首文档竞态。
#[test]
fn login_guard_extension_manifest_pins_document_start_main_world_script() {
    let root = scratch_dir("extension-manifest");
    let path = write_login_guard_extension(&root, MANAGED_PLATFORM_URL).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["manifest_version"], 3);
    assert_eq!(manifest["name"], "Vestus 登录防护");
    assert_eq!(manifest["version"], "1.0.0");
    let scripts = manifest["content_scripts"].as_array().unwrap();
    assert_eq!(scripts.len(), 1);
    assert_eq!(scripts[0]["js"], serde_json::json!(["guard.js"]));
    // matches 用策略 login_route 的 origin，而不是 target 的任意路径。
    assert_eq!(
        scripts[0]["matches"],
        serde_json::json!(["https://agent.oceanengine.com/*"])
    );
    assert_eq!(scripts[0]["run_at"], "document_start");
    assert_eq!(scripts[0]["all_frames"], false);
    assert_eq!(scripts[0]["world"], "MAIN");
    let _ = std::fs::remove_dir_all(root);
}

/// guard.js 必须逐字节等于现有策略的 login_guard_script() 输出：模板只有一份，
/// route 配置在生成期写死（MAIN 世界没有 chrome.runtime 可读配置）。
#[test]
fn login_guard_extension_script_is_the_exact_policy_guard_script() {
    let root = scratch_dir("extension-script");
    let path = write_login_guard_extension(&root, MANAGED_PLATFORM_URL).unwrap();
    let guard = std::fs::read_to_string(path.join("guard.js")).unwrap();
    assert_eq!(guard, logout_guard_script(MANAGED_PLATFORM_URL).unwrap());
    assert!(guard.contains("__vestusManagedLoginGuard"));
    assert!(guard.contains("\"origin\":\"https://agent.oceanengine.com\""));
    assert!(guard.contains("\"path\":\"/login\""));
    let _ = std::fs::remove_dir_all(root);
}

/// 重复生成必须幂等，并且能修复被篡改的旧文件——启动前 profile 可能残留
/// 上一轮未清理干净的内容。
#[test]
fn login_guard_extension_regeneration_is_stable_and_repairs_tampered_files() {
    let root = scratch_dir("extension-regen");
    let path = write_login_guard_extension(&root, MANAGED_PLATFORM_URL).unwrap();
    let first_manifest = std::fs::read(path.join("manifest.json")).unwrap();
    let first_guard = std::fs::read(path.join("guard.js")).unwrap();
    std::fs::write(path.join("manifest.json"), b"tampered").unwrap();
    std::fs::write(path.join("guard.js"), b"tampered").unwrap();
    let again = write_login_guard_extension(&root, MANAGED_PLATFORM_URL).unwrap();
    assert_eq!(again, path);
    assert_eq!(
        std::fs::read(path.join("manifest.json")).unwrap(),
        first_manifest
    );
    assert_eq!(std::fs::read(path.join("guard.js")).unwrap(), first_guard);
    let _ = std::fs::remove_dir_all(root);
}

/// 不支持的平台必须显式失败（fail closed），而不是静默生成一个没有防护的空壳。
#[test]
fn login_guard_extension_requires_a_supported_platform() {
    let root = scratch_dir("extension-unsupported");
    let error = write_login_guard_extension(&root, "https://other.example/workbench").unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(
        error
            .to_string()
            .contains("managed login guard requires a supported platform"),
        "unexpected error: {error}"
    );
    assert!(!root.join("vestus-login-guard-extension").exists());
    let _ = std::fs::remove_dir_all(root);
}

/// 文件系统失败必须原样以 io::Error 冒出，让启动链路翻成
/// managed_guard_unavailable；不能吞掉错误继续启动无防护的浏览器。
#[test]
fn login_guard_extension_propagates_filesystem_failures() {
    let root = scratch_dir("extension-blocked");
    std::fs::write(
        root.join("vestus-login-guard-extension"),
        b"not a directory",
    )
    .unwrap();
    let error = write_login_guard_extension(&root, MANAGED_PLATFORM_URL).unwrap_err();
    assert!(
        !matches!(error.kind(), std::io::ErrorKind::InvalidInput),
        "filesystem failure must surface as an io error, got {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}
