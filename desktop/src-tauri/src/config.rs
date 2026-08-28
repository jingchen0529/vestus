//! 管理员下发代理配置的校验。
//!
//! 完整配置只保留在当前 Rust 会话内存中；桌面端不提供手工编辑，也不
//! 把代理地址、账号或口令写入本地文件。

use serde::Deserialize;

use crate::bypass::DirectHosts;
use crate::upstream::UpstreamProxy;

/// 服务端响应中的代理表单，含明文口令，仅存在于 Rust 内存中。
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyForm {
    pub host: String,
    pub port: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub probe_url: String,
    /// 管理员下发的直连域名。缺省为空，即所有流量都走代理。
    #[serde(default)]
    pub bypass_hosts: Vec<String>,
}

/// 校验通过后的配置。
#[derive(Clone)]
pub struct ValidatedConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub probe_url: String,
    /// 直连例外。空集合表示「全部走代理」。
    pub direct_hosts: DirectHosts,
}

/// Validated platform shortcut retained only in Rust as the browser launch
/// allowlist. This intentionally contains no proxy credential fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPlatform {
    pub id: i64,
    pub name: String,
    pub url: String,
    pub icon_url: Option<String>,
    pub sort_order: i64,
}

impl ValidatedConfig {
    pub fn upstream(&self) -> UpstreamProxy {
        UpstreamProxy::new(
            self.host.clone(),
            self.port,
            self.username.clone(),
            self.password.clone(),
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0}")]
    Invalid(String),
}

/// 校验表单。空值、端口越界、非法 URL 都在这里拦下。
pub fn validate(form: &ProxyForm) -> Result<ValidatedConfig, ConfigError> {
    let host = form.host.trim().to_string();
    if host.is_empty() {
        return Err(ConfigError::Invalid("请填写代理 IP 或域名".into()));
    }
    // 避免把 scheme 或路径混进 host
    if host.contains("://")
        || host.contains('/')
        || host.chars().any(|character| character.is_whitespace())
    {
        return Err(ConfigError::Invalid(
            "代理 IP 只填地址，不要带 http:// 或路径".into(),
        ));
    }
    if host.contains('@') {
        return Err(ConfigError::Invalid("代理 IP 不能包含账号信息".into()));
    }

    let port_text = form.port.trim();
    if port_text.is_empty() {
        return Err(ConfigError::Invalid("请填写代理端口".into()));
    }
    let port: u16 = port_text
        .parse()
        .map_err(|_| ConfigError::Invalid("代理端口必须是 1～65535 的整数".into()))?;
    if port == 0 {
        return Err(ConfigError::Invalid("代理端口必须在 1～65535 之间".into()));
    }

    let username = form.username.trim().to_string();
    if username.is_empty() {
        return Err(ConfigError::Invalid("请填写代理账号".into()));
    }
    // 冒号会破坏 Basic 认证的 user:pass 结构
    if username.contains(':') {
        return Err(ConfigError::Invalid("代理账号不能包含冒号".into()));
    }

    // 口令不做 trim：首尾空格可能是有效字符
    let password = form.password.clone();
    if password.is_empty() {
        return Err(ConfigError::Invalid("请填写代理密码".into()));
    }

    let probe_url = normalize_url(&form.probe_url, "出口检测地址")?;

    // 直连例外必须在这里拦下：适配器只认已校验过的列表。
    let direct_hosts = DirectHosts::parse(&form.bypass_hosts)
        .map_err(|error| ConfigError::Invalid(error.to_string()))?;

    Ok(ValidatedConfig {
        host,
        port,
        username,
        password,
        probe_url,
        direct_hosts,
    })
}

fn normalize_url(input: &str, label: &str) -> Result<String, ConfigError> {
    let candidate = input.trim();
    if candidate.is_empty() {
        return Err(ConfigError::Invalid(format!("{label}不能为空")));
    }
    let parsed = url::Url::parse(candidate)
        .map_err(|_| ConfigError::Invalid(format!("{label}格式不正确：{candidate}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ConfigError::Invalid(format!("{label}只支持 http 或 https")));
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form() -> ProxyForm {
        ProxyForm {
            host: "203.0.113.10".into(),
            port: "8080".into(),
            username: "proxy_user".into(),
            password: "s3cret".into(),
            probe_url: "https://api.example.test/api/network/ip".into(),
            bypass_hosts: Vec::new(),
        }
    }

    #[test]
    fn accepts_valid_form_with_explicit_probe_url() {
        let cfg = validate(&form()).unwrap();
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.probe_url, "https://api.example.test/api/network/ip");
        // 缺省没有任何直连例外
        assert!(cfg.direct_hosts.is_empty());
    }

    #[test]
    fn rejects_missing_probe_url_instead_of_using_a_third_party_default() {
        let mut f = form();
        f.probe_url.clear();

        let error = match validate(&f) {
            Ok(_) => panic!("缺少自有探测地址时不应回退到第三方服务"),
            Err(error) => error,
        };

        assert_eq!(error.to_string(), "出口检测地址不能为空");
    }

    #[test]
    fn normalizes_bypass_hosts_and_rejects_bad_entries() {
        let mut f = form();
        f.bypass_hosts = vec![
            "LF3-AD-Platform.byteadverts.com".into(),
            ".byteadverts.com".into(),
        ];
        let cfg = validate(&f).unwrap();
        assert_eq!(
            cfg.direct_hosts.entries(),
            vec![
                "lf3-ad-platform.byteadverts.com".to_string(),
                "*.byteadverts.com".to_string()
            ]
        );

        for bad in ["127.0.0.1", "localhost", "http://a.com", "a.com:8080"] {
            let mut f = form();
            f.bypass_hosts = vec![bad.into()];
            assert!(validate(&f).is_err(), "应当拒绝直连域名：{bad}");
        }
    }

    #[test]
    fn rejects_empty_fields() {
        for mutate in [
            (|f: &mut ProxyForm| f.host = "  ".into()) as fn(&mut ProxyForm),
            |f: &mut ProxyForm| f.port = String::new(),
            |f: &mut ProxyForm| f.username = String::new(),
            |f: &mut ProxyForm| f.password = String::new(),
        ] {
            let mut f = form();
            mutate(&mut f);
            assert!(validate(&f).is_err());
        }
    }

    #[test]
    fn rejects_out_of_range_port() {
        let mut f = form();
        f.port = "70000".into();
        assert!(validate(&f).is_err());
        f.port = "0".into();
        assert!(validate(&f).is_err());
    }

    #[test]
    fn rejects_scheme_in_host() {
        let mut f = form();
        f.host = "http://203.0.113.10".into();
        assert!(validate(&f).is_err());
        f.host = "proxy host.test".into();
        assert!(validate(&f).is_err());
    }

    #[test]
    fn rejects_colon_in_username() {
        let mut f = form();
        f.username = "user:name".into();
        assert!(validate(&f).is_err());
    }

    #[test]
    fn keeps_password_whitespace() {
        let mut f = form();
        f.password = " pad ".into();
        assert_eq!(validate(&f).unwrap().password, " pad ");
    }
}
