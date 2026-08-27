//! 管理员下发的直连域名列表，对应 Playwright `Proxy.Bypass`。
//!
//! 默认所有流量都必须经过上游代理。只有主机名命中本列表时，
//! [`DirectHosts::connect`] 才会由本机直接连接目标站点——这条例外只能由
//! 管理员在后台配置，桌面端界面和被打开的网页都无法自行追加。
//!
//! 安全边界：
//! 1. 只接受主机名。IP 字面量、`localhost`、端口、路径、协议前缀一律拒绝。
//! 2. 直连前解析地址并拒绝回环、未指定、组播、链路本地地址，避免适配器
//!    被当成访问本机或链路本地服务的跳板。
//! 3. 列表为空时本模块不会发起任何连接，全应用退回「只有上游代理出站」。
//! 4. 命中列表的域名**永远**直连：直连失败不会退回代理，代理失败也不会
//!    改走直连，路由结果始终可预测。
//!
//! 注意：直连意味着该域名的请求使用本机真实出口 IP，不再具备代理提供的
//! 出口伪装。这是管理员显式选择的结果。

use std::net::IpAddr;

use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::upstream::CONNECT_TIMEOUT;

/// 单个用户最多允许的直连条目，防止管理员误粘贴整份域名表。
pub const MAX_DIRECT_HOSTS: usize = 32;
const MAX_HOST_LENGTH: usize = 253;
const MAX_LABEL_LENGTH: usize = 63;

#[derive(Debug, thiserror::Error)]
pub enum BypassError {
    #[error("{0}")]
    Invalid(String),
}

/// 直连时的失败原因，与 [`crate::upstream::TunnelError`] 一样映射为短代码。
#[derive(Debug, Clone, thiserror::Error)]
pub enum DirectError {
    #[error("直连域名解析失败：{0}")]
    Unresolved(String),
    #[error("直连目标地址被安全策略拒绝")]
    Blocked,
    #[error("无法直连目标站点：{0}")]
    ConnectFailed(String),
    #[error("直连目标站点超时")]
    ConnectTimeout,
}

impl DirectError {
    pub fn code(&self) -> &'static str {
        match self {
            DirectError::Unresolved(_) => "direct_unresolved",
            DirectError::Blocked => "direct_blocked",
            DirectError::ConnectFailed(_) => "direct_connect_failed",
            DirectError::ConnectTimeout => "direct_connect_timeout",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HostPattern {
    /// 精确匹配单个主机名。
    Exact(String),
    /// 匹配所有子域，不含域名本身（与 Chromium `*.example.com` 一致）。
    Subdomain(String),
}

/// 允许直连的主机名集合。空集合表示「没有任何直连例外」。
#[derive(Debug, Clone, Default)]
pub struct DirectHosts {
    patterns: Vec<HostPattern>,
    /// 单元测试用的假源站地址。发布构建里该字段不存在。
    #[cfg(test)]
    test_target: Option<std::net::SocketAddr>,
}

impl DirectHosts {
    /// 「没有任何直连例外」的集合。生产路径上的空列表由
    /// [`Self::parse`] 产出，这里只服务于单元测试。
    #[cfg(test)]
    pub fn empty() -> Self {
        Self::default()
    }

    /// 校验并归一化管理员下发的条目。
    ///
    /// 支持两种写法：`host.example.com` 精确匹配，`*.example.com`
    /// （或等价的 `.example.com`）匹配其所有子域。
    pub fn parse(entries: &[String]) -> Result<Self, BypassError> {
        if entries.len() > MAX_DIRECT_HOSTS {
            return Err(BypassError::Invalid(format!(
                "直连域名最多 {MAX_DIRECT_HOSTS} 条"
            )));
        }
        let mut patterns: Vec<HostPattern> = Vec::with_capacity(entries.len());
        for entry in entries {
            let pattern = parse_pattern(entry)?;
            if !patterns.contains(&pattern) {
                patterns.push(pattern);
            }
        }
        Ok(Self {
            patterns,
            #[cfg(test)]
            test_target: None,
        })
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// 归一化后的条目，供界面展示与日志说明使用。
    pub fn entries(&self) -> Vec<String> {
        self.patterns
            .iter()
            .map(|pattern| match pattern {
                HostPattern::Exact(host) => host.clone(),
                HostPattern::Subdomain(domain) => format!("*.{domain}"),
            })
            .collect()
    }

    /// 判断一个请求主机名是否走直连。
    pub fn matches(&self, host: &str) -> bool {
        let host = normalize_request_host(host);
        if host.is_empty() {
            return false;
        }
        self.patterns.iter().any(|pattern| match pattern {
            HostPattern::Exact(expected) => host == *expected,
            HostPattern::Subdomain(domain) => host
                .strip_suffix(domain.as_str())
                .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1),
        })
    }

    /// 直接连接目标站点。全应用第二个（也是最后一个）出站连接点，
    /// 另一个是 [`crate::upstream::UpstreamProxy::connect`]。
    pub async fn connect(&self, host: &str, port: u16) -> Result<TcpStream, DirectError> {
        #[cfg(test)]
        if let Some(target) = self.test_target {
            let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(target))
                .await
                .map_err(|_| DirectError::ConnectTimeout)?
                .map_err(|error| DirectError::ConnectFailed(error.to_string()))?;
            stream.set_nodelay(true).ok();
            return Ok(stream);
        }

        let candidates = timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| DirectError::ConnectTimeout)?
            .map_err(|error| DirectError::Unresolved(error.to_string()))?;

        let mut allowed = Vec::new();
        let mut blocked = false;
        for candidate in candidates {
            if is_safe_direct_address(&candidate.ip()) {
                allowed.push(candidate);
            } else {
                blocked = true;
            }
        }
        if allowed.is_empty() {
            return Err(if blocked {
                DirectError::Blocked
            } else {
                DirectError::Unresolved("没有可用地址".into())
            });
        }

        let mut last = DirectError::Unresolved("没有可用地址".into());
        for candidate in allowed {
            match timeout(CONNECT_TIMEOUT, TcpStream::connect(candidate)).await {
                Ok(Ok(stream)) => {
                    stream.set_nodelay(true).ok();
                    return Ok(stream);
                }
                Ok(Err(error)) => last = DirectError::ConnectFailed(error.to_string()),
                Err(_) => last = DirectError::ConnectTimeout,
            }
        }
        Err(last)
    }

    /// 让适配器测试可以把「直连」指向本机假源站。
    #[cfg(test)]
    pub fn for_tests(entries: &[&str], target: std::net::SocketAddr) -> Self {
        let owned: Vec<String> = entries.iter().map(|entry| (*entry).to_string()).collect();
        let mut hosts = Self::parse(&owned).expect("测试用直连条目必须合法");
        hosts.test_target = Some(target);
        hosts
    }
}

/// 直连允许的目标地址范围。回环、未指定、组播和链路本地一律拒绝；
/// 内网段保留放行，因为管理员可能确实要直连内部平台。
fn is_safe_direct_address(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_safe_ipv4_address(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_safe_ipv4_address(&v4);
            }
            let segments = v6.segments();
            let link_local = (segments[0] & 0xffc0) == 0xfe80;
            !v6.is_loopback() && !v6.is_unspecified() && !v6.is_multicast() && !link_local
        }
    }
}

fn is_safe_ipv4_address(ip: &std::net::Ipv4Addr) -> bool {
    !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_multicast()
        && !ip.is_broadcast()
        && !ip.is_link_local()
}

/// 请求里的主机名归一化：去掉 IPv6 方括号、结尾点，统一小写。
fn normalize_request_host(host: &str) -> String {
    let host = host.trim();
    let host = host.strip_prefix('[').unwrap_or(host);
    let host = host.strip_suffix(']').unwrap_or(host);
    let host = host.strip_suffix('.').unwrap_or(host);
    host.to_ascii_lowercase()
}

fn parse_pattern(raw: &str) -> Result<HostPattern, BypassError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(BypassError::Invalid("直连域名不能为空".into()));
    }
    if !text.is_ascii() {
        return Err(BypassError::Invalid(format!(
            "直连域名只接受 ASCII，中文域名请填 punycode：{text}"
        )));
    }
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("://")
        || lowered.contains('/')
        || lowered.contains('@')
        || lowered.contains(':')
        || lowered.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(BypassError::Invalid(format!(
            "直连域名只填主机名，不要带协议、端口或路径：{text}"
        )));
    }

    let (host, subdomain_only) = match lowered.strip_prefix("*.") {
        Some(rest) => (rest.to_string(), true),
        None => match lowered.strip_prefix('.') {
            Some(rest) => (rest.to_string(), true),
            None => (lowered.clone(), false),
        },
    };
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();

    if host.is_empty() || host.len() > MAX_HOST_LENGTH {
        return Err(BypassError::Invalid(format!("直连域名长度不合法：{text}")));
    }
    if host.parse::<IpAddr>().is_ok() {
        return Err(BypassError::Invalid(format!(
            "直连列表只接受域名，不接受 IP 地址：{text}"
        )));
    }
    if host == "localhost" || host.ends_with(".localhost") {
        return Err(BypassError::Invalid(
            "直连列表不允许本机域名 localhost".into(),
        ));
    }
    if !host.contains('.') {
        return Err(BypassError::Invalid(format!(
            "直连域名至少要包含一个点，例如 lf3-ad-platform.byteadverts.com：{text}"
        )));
    }
    for label in host.split('.') {
        let valid = !label.is_empty()
            && label.len() <= MAX_LABEL_LENGTH
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid {
            return Err(BypassError::Invalid(format!("直连域名格式不正确：{text}")));
        }
    }

    Ok(if subdomain_only {
        HostPattern::Subdomain(host)
    } else {
        HostPattern::Exact(host)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(entries: &[&str]) -> DirectHosts {
        let owned: Vec<String> = entries.iter().map(|e| (*e).to_string()).collect();
        DirectHosts::parse(&owned).unwrap()
    }

    #[test]
    fn empty_list_matches_nothing() {
        let list = DirectHosts::empty();
        assert!(list.is_empty());
        assert!(!list.matches("lf3-ad-platform.byteadverts.com"));
    }

    #[test]
    fn exact_host_matches_case_insensitively_and_ignores_trailing_dot() {
        let list = hosts(&["lf3-ad-platform.byteadverts.com"]);
        assert!(list.matches("lf3-ad-platform.byteadverts.com"));
        assert!(list.matches("LF3-AD-Platform.ByteAdverts.com."));
        assert!(!list.matches("evil-lf3-ad-platform.byteadverts.com"));
        assert!(!list.matches("byteadverts.com"));
        assert!(!list.matches("lf3-ad-platform.byteadverts.com.attacker.test"));
    }

    #[test]
    fn subdomain_pattern_excludes_apex() {
        let list = hosts(&["*.byteadverts.com"]);
        assert!(list.matches("lf3-ad-platform.byteadverts.com"));
        assert!(list.matches("a.b.byteadverts.com"));
        assert!(!list.matches("byteadverts.com"));
        assert!(!list.matches("notbyteadverts.com"));
        assert_eq!(list.entries(), vec!["*.byteadverts.com".to_string()]);
    }

    #[test]
    fn leading_dot_is_the_same_as_star_dot() {
        assert_eq!(
            hosts(&[".byteadverts.com"]).entries(),
            hosts(&["*.byteadverts.com"]).entries()
        );
    }

    #[test]
    fn duplicates_collapse() {
        let list = hosts(&[
            "lf3-ad-platform.byteadverts.com",
            " LF3-AD-PLATFORM.byteadverts.com ",
        ]);
        assert_eq!(list.entries().len(), 1);
    }

    #[test]
    fn rejects_addresses_schemes_ports_and_local_names() {
        for bad in [
            "",
            "   ",
            "127.0.0.1",
            "::1",
            "10.0.0.5",
            "localhost",
            "app.localhost",
            "http://example.com",
            "example.com/path",
            "user@example.com",
            "example.com:8080",
            "example .com",
            "singlelabel",
            "-bad.example.com",
            "bad-.example.com",
            "例子.com",
            "a..example.com",
        ] {
            assert!(
                DirectHosts::parse(&[bad.to_string()]).is_err(),
                "应当拒绝：{bad}"
            );
        }
    }

    #[test]
    fn rejects_oversized_list() {
        let entries: Vec<String> = (0..MAX_DIRECT_HOSTS + 1)
            .map(|index| format!("host{index}.example.com"))
            .collect();
        assert!(DirectHosts::parse(&entries).is_err());
    }

    #[test]
    fn blocks_loopback_and_link_local_targets() {
        assert!(!is_safe_direct_address(&"127.0.0.1".parse().unwrap()));
        assert!(!is_safe_direct_address(&"0.0.0.0".parse().unwrap()));
        assert!(!is_safe_direct_address(&"169.254.1.2".parse().unwrap()));
        assert!(!is_safe_direct_address(&"224.0.0.1".parse().unwrap()));
        assert!(!is_safe_direct_address(&"::1".parse().unwrap()));
        assert!(!is_safe_direct_address(&"fe80::1".parse().unwrap()));
        assert!(is_safe_direct_address(&"203.0.113.10".parse().unwrap()));
        assert!(is_safe_direct_address(&"2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn blocks_forbidden_ipv4_mapped_ipv6_targets() {
        assert!(!is_safe_direct_address(
            &"::ffff:127.0.0.1".parse().unwrap()
        ));
        assert!(!is_safe_direct_address(
            &"::ffff:169.254.169.254".parse().unwrap()
        ));
        assert!(!is_safe_direct_address(&"::ffff:0.0.0.0".parse().unwrap()));
        assert!(!is_safe_direct_address(
            &"::ffff:224.0.0.1".parse().unwrap()
        ));
        assert!(is_safe_direct_address(
            &"::ffff:203.0.113.10".parse().unwrap()
        ));
    }

    #[test]
    fn direct_connect_refuses_hosts_resolving_to_loopback() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            // 即使域名解析结果落在回环地址上也必须被地址过滤拦下，
            // 绝不允许适配器借直连去连本机端口。
            let list = hosts(&["lf3-ad-platform.byteadverts.com"]);
            let outcome = list.connect("127.0.0.1", 80).await;
            assert!(
                matches!(&outcome, Err(DirectError::Blocked)),
                "回环目标必须被拒绝"
            );
        });
    }
}
