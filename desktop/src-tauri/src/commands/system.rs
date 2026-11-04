//! 系统类命令:状态、出口 IP、外链、版本检查。

use std::time::Duration;

use url::Url;

use crate::auth::DesktopAuthState;
use crate::probe;
use crate::state::{AppState, StatusView};

use super::*;

/// 当前状态快照。前端轮询或收到事件后调用。
#[tauri::command]
pub fn get_status(
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
) -> CmdResult<StatusView> {
    require_desktop_auth(&auth)?;
    Ok(state.snapshot())
}

/// 获取用户当前本机的公网出口 IP（直连模式下展示）。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_direct_ip(auth: tauri::State<'_, DesktopAuthState>) -> CmdResult<String> {
    require_desktop_auth(&auth)?;
    let api_base = auth.api_base_url().map_err(auth_command_error)?;
    let probe_url = network_probe_url(api_base);
    probe::probe_direct(&probe_url)
        .await
        .map_err(|error| CommandError::new(format!("获取本机公网 IP 失败：{error}"), error.code()))
}

/// 在操作系统默认浏览器中打开指定的外部 HTTP/HTTPS 链接（如 GitHub Release 与安装包下载）。
#[tauri::command(rename_all = "camelCase")]
pub async fn open_external_url(url: String) -> CmdResult<()> {
    let parsed =
        Url::parse(&url).map_err(|_| CommandError::new("无效的网址格式", "invalid_url"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(CommandError::new(
            "仅支持打开 HTTP 或 HTTPS 链接",
            "invalid_scheme",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| {
                CommandError::new(format!("打开系统默认浏览器失败：{e}"), "open_failed")
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| {
                CommandError::new(format!("打开系统默认浏览器失败：{e}"), "open_failed")
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| {
                CommandError::new(format!("打开系统默认浏览器失败：{e}"), "open_failed")
            })?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return Err(CommandError::new(
            "当前操作系统不支持自动打开外部浏览器",
            "unsupported_os",
        ));
    }

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubReleaseAssetView {
    pub name: String,
    pub download_url: String,
    pub size: i64,
    pub platform: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubReleaseCheckView {
    pub tag_name: String,
    pub latest_version: String,
    pub published_at: String,
    pub html_url: String,
    pub body: String,
    pub assets: Vec<GithubReleaseAssetView>,
}

#[derive(serde::Deserialize)]
pub(crate) struct RawGithubAsset {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(rename = "browser_download_url", default)]
    pub(crate) browser_download_url: String,
    #[serde(default)]
    pub(crate) size: i64,
}

#[derive(serde::Deserialize)]
pub(crate) struct RawGithubRelease {
    #[serde(rename = "tag_name", default)]
    pub(crate) tag_name: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(rename = "published_at", default)]
    pub(crate) published_at: String,
    #[serde(rename = "html_url", default)]
    pub(crate) html_url: String,
    #[serde(default)]
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) assets: Vec<RawGithubAsset>,
}

pub(crate) fn classify_asset_platform(filename: &str) -> String {
    let name_lower = filename.to_lowercase();
    if name_lower.contains("macos") || name_lower.contains("darwin") || name_lower.contains(".dmg")
    {
        if name_lower.contains("aarch64")
            || name_lower.contains("arm64")
            || name_lower.contains("m1")
            || name_lower.contains("apple")
        {
            return "macOS (Apple Silicon M系列)".to_string();
        }
        return "macOS (Intel x86_64)".to_string();
    }
    if name_lower.contains("windows") || name_lower.contains(".exe") || name_lower.contains(".msi")
    {
        return "Windows (x86_64)".to_string();
    }
    if name_lower.contains("appimage") {
        return "Linux (AppImage)".to_string();
    }
    if name_lower.contains(".deb") {
        return "Linux (Debian / Ubuntu)".to_string();
    }
    "通用安装包".to_string()
}

pub(crate) fn normalize_version_str(ver: &str) -> String {
    let trimmed = ver.trim();
    let stripped_desktop = trimmed.strip_prefix("desktop-").unwrap_or(trimmed);
    let stripped_v = stripped_desktop
        .strip_prefix('v')
        .unwrap_or(stripped_desktop);
    stripped_v.to_string()
}

/// 由 Rust 原生端请求 GitHub API 获取 Release 版本信息，彻底规避 WebView CSP 拦截。
#[tauri::command(rename_all = "camelCase")]
pub async fn check_github_release(repo: Option<String>) -> CmdResult<GithubReleaseCheckView> {
    let clean_repo = repo
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| "jingchen0529/vestus".to_string());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Vestus-Desktop-Client")
        .build()
        .map_err(|e| CommandError::new(format!("初始化网络客户端失败：{e}"), "client_init"))?;

    let url = format!("https://api.github.com/repos/{clean_repo}/releases/latest");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await;

    let raw_release = match resp {
        Ok(res) if res.status().is_success() => res
            .json::<RawGithubRelease>()
            .await
            .map_err(|e| CommandError::new(format!("解析版本信息失败：{e}"), "json_parse"))?,
        Ok(res) if res.status() == reqwest::StatusCode::NOT_FOUND => {
            let list_url = format!("https://api.github.com/repos/{clean_repo}/releases");
            let list_res = client
                .get(&list_url)
                .header("Accept", "application/vnd.github.v3+json")
                .send()
                .await
                .map_err(|e| {
                    CommandError::new(format!("连接 GitHub 失败：{e}"), "network_error")
                })?;

            if !list_res.status().is_success() {
                return Err(CommandError::new(
                    format!("获取 GitHub Release 失败 (HTTP {})", list_res.status()),
                    "release_not_found",
                ));
            }

            let mut list = list_res
                .json::<Vec<RawGithubRelease>>()
                .await
                .map_err(|e| CommandError::new(format!("解析版本列表失败：{e}"), "json_parse"))?;

            if list.is_empty() {
                return Err(CommandError::new(
                    "未在 GitHub 找到已发布的版本",
                    "no_release",
                ));
            }
            list.remove(0)
        }
        Ok(res) if res.status() == reqwest::StatusCode::FORBIDDEN => {
            return Err(CommandError::new(
                "GitHub API 访问频次受限，请稍后重试",
                "rate_limited",
            ));
        }
        Ok(res) => {
            return Err(CommandError::new(
                format!("GitHub 返回异常状态码: HTTP {}", res.status()),
                "http_error",
            ));
        }
        Err(e) => {
            return Err(CommandError::new(
                format!("连接 GitHub 失败，请检查网络连接：{e}"),
                "network_error",
            ));
        }
    };

    let tag_name = raw_release.tag_name.clone();
    let latest_version = if !tag_name.is_empty() {
        normalize_version_str(&tag_name)
    } else {
        normalize_version_str(&raw_release.name)
    };

    let assets = raw_release
        .assets
        .into_iter()
        .map(|a| {
            let platform = classify_asset_platform(&a.name);
            GithubReleaseAssetView {
                name: a.name,
                download_url: a.browser_download_url,
                size: a.size,
                platform,
            }
        })
        .collect();

    Ok(GithubReleaseCheckView {
        tag_name,
        latest_version,
        published_at: raw_release.published_at,
        html_url: if !raw_release.html_url.is_empty() {
            raw_release.html_url
        } else {
            format!("https://github.com/{clean_repo}/releases")
        },
        body: raw_release.body,
        assets,
    })
}
