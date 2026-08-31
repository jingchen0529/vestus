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
    // 出口检测地址是**上游代理那一侧**去访问的。代理在远端而检测地址指向本机时，
    // 它在代理服务器上解析成代理机自己，必然打不通——而失败形态取决于代理实现
    // （连接被拒、超时、或者一个无关的响应），从报错反推原因的成本极高。在这里
    // 就说清楚，比让它撞上去再翻译网络错误好。
    //
    // 上游代理本身就在本机（本地代理软件）时，这个组合是可达的，不拦。
    let probe_host = url::Url::parse(&probe_url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default();
    if is_loopback_host(&probe_host) && !is_loopback_host(&host) {
        return Err(ConfigError::Invalid(format!(
            "出口检测地址 {probe_host} 指向本机，而上游代理在远端（{host}）——代理访问不到它，\
             请把桌面端的 API 地址设为公网可达的地址"
        )));
    }

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

/// 这个主机名是否指向「本机」。
///
/// 只做字面判断，不做 DNS 解析：校验阶段还没到网络层，而这里要拦下的恰恰是
/// `127.0.0.1` / `localhost` / `0.0.0.0` 这种一眼可辨的情况。
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback() || ip.is_unspecified();
    }
    host == "localhost" || host.ends_with(".localhost")
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

    /// 远端代理 + 指向本机的检测地址是必然失败的组合：代理那一侧的 `127.0.0.1`
    /// 是代理机自己。让它撞上去只会得到一句取决于代理实现的网络错误。
    #[test]
    fn rejects_a_loopback_probe_url_when_the_proxy_is_remote() {
        for loopback in [
            "http://127.0.0.1:8000/api/network/ip",
            "http://localhost:8000/api/network/ip",
            "http://[::1]:8000/api/network/ip",
            "http://0.0.0.0:8000/api/network/ip",
        ] {
            let mut f = form();
            f.probe_url = loopback.into();

            let error = match validate(&f) {
                Ok(_) => panic!("远端代理配上本机检测地址不应通过：{loopback}"),
                Err(error) => error,
            };
            let text = error.to_string();
            assert!(text.contains("指向本机"), "{loopback} -> {text}");
            // 提示必须点出上游代理是谁，否则看不出「本机」是相对谁而言
            assert!(text.contains("203.0.113.10"), "{loopback} -> {text}");
        }
    }

    /// 上游代理本身就在本机（本地代理软件）时，这个组合是可达的，不能误伤。
    #[test]
    fn keeps_a_loopback_probe_url_when_the_proxy_is_also_local() {
        let mut f = form();
        f.host = "127.0.0.1".into();
        f.probe_url = "http://127.0.0.1:8000/api/network/ip".into();

        let cfg = validate(&f).expect("本机代理配本机检测地址是可达的");
        assert_eq!(cfg.probe_url, "http://127.0.0.1:8000/api/network/ip");
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
