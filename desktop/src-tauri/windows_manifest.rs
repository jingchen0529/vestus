use std::path::Path;

pub fn link_arguments(target_os: &str, target_env: &str, manifest: &Path) -> Vec<String> {
    if target_os != "windows" || target_env != "msvc" {
        return Vec::new();
    }
    vec![
        "cargo:rustc-link-arg=/MANIFEST:EMBED".into(),
        format!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msvc_embeds_manifest_for_library_tests_as_well_as_the_app() {
        assert_eq!(
            link_arguments("windows", "msvc", Path::new("manifest.xml")),
            vec![
                "cargo:rustc-link-arg=/MANIFEST:EMBED",
                "cargo:rustc-link-arg=/MANIFESTINPUT:manifest.xml",
            ]
        );
    }

    #[test]
    fn other_targets_do_not_receive_msvc_linker_flags() {
        for (os, env) in [("windows", "gnu"), ("linux", "gnu"), ("macos", "")] {
            assert!(link_arguments(os, env, Path::new("manifest.xml")).is_empty());
        }
    }

    #[test]
    fn manifest_declares_controls_v6_without_requesting_elevation() {
        let manifest = include_str!("windows-app-manifest.xml");
        assert!(manifest.contains("Microsoft.Windows.Common-Controls"));
        assert!(manifest.contains("version=\"6.0.0.0\""));
        assert!(manifest.contains("publicKeyToken=\"6595b64144ccf1df\""));
        assert!(!manifest.contains("requireAdministrator"));
    }
}
