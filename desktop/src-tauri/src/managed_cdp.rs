//! Restricted DevTools controls for administrator-managed platform sessions.
//!
//! This module is deliberately separate from [`crate::cdp`].  The latter is a
//! read-only activity collector; this module is the only place where a managed
//! session may write browser state. It validates the host boundary before the
//! fixed cookie injection/navigation commands, and installs a fixed login guard
//! on every managed page through a separate, fail-closed connection.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::client_async_with_config;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use url::Url;

use crate::browser::DevToolsEndpoint;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const SET_COOKIES_COMMAND_ID: i64 = 1;
const NAVIGATE_COMMAND_ID: i64 = 2;
const TARGETS_COMMAND_ID: i64 = 3;
const ATTACH_COMMAND_ID: i64 = 4;
const DETACH_COMMAND_ID: i64 = 5;

/// Immutable identity of the credential actually installed in a browser.
/// Kept in Rust only; neither credentials nor navigation URLs enter reports.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedSessionIdentity {
    pub(crate) session_id: String,
    pub(crate) managed_account_id: u64,
    pub(crate) credential_version: u64,
}

impl ManagedSessionIdentity {
    fn from_bootstrap(wire: &ManagedBootstrapWire) -> Result<Self, ManagedCdpError> {
        let session_id = wire.session_id.parse::<i64>().ok();
        if !session_id.is_some_and(|id| id > 0)
            || !wire.session_id.bytes().all(|byte| byte.is_ascii_digit())
            || wire.managed_account_id == 0
            || wire.managed_account_id > i64::MAX as u64
            || wire.credential_version == 0
            || wire.credential_version > i64::MAX as u64
        {
            return Err(ManagedCdpError::SessionIdentityInvalid);
        }
        Ok(Self {
            session_id: wire.session_id.clone(),
            managed_account_id: wire.managed_account_id,
            credential_version: wire.credential_version,
        })
    }
}

/// The server-shaped managed session received by the Rust-only launch path.
///
/// This is intentionally not part of the generic desktop config DTO.  A
/// future bootstrap endpoint can deserialize into this type without exposing
/// the cookie bundle to React or to the activity collector.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedSessionWire {
    #[serde(alias = "target_url")]
    pub(crate) target_url: String,
    #[serde(alias = "allowed_hosts")]
    pub(crate) allowed_hosts: Vec<String>,
    pub(crate) cookies: Vec<ManagedCookieWire>,
}

/// Exact response shape of the one-time bootstrap consume endpoint.  Session
/// metadata stays in Rust for lease/audit handling and never reaches CDP.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedBootstrapWire {
    pub(crate) session_id: String,
    pub(crate) managed_account_id: u64,
    pub(crate) credential_version: u64,
    /// The server echoes the platform URL in the consumed grant.  The launch
    /// path still supplies the locally allowlisted URL to
    /// [`managed_session_from_bootstrap`]; this field is kept here so an
    /// unexpected response cannot silently smuggle extra data through the
    /// strict wire shape.
    #[serde(alias = "target_url")]
    pub(crate) target_url: String,
    #[serde(alias = "cookies")]
    pub(crate) cookie_bundle: Vec<ManagedCookieWire>,
    pub(crate) allowed_hosts: Vec<String>,
    pub(crate) expires_at: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedCookieWire {
    pub(crate) name: String,
    pub(crate) value: String,
    pub(crate) domain: String,
    #[serde(default = "default_cookie_path")]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) secure: bool,
    #[serde(default)]
    pub(crate) http_only: bool,
    #[serde(default)]
    pub(crate) same_site: Option<String>,
    #[serde(default)]
    pub(crate) expires_at: Option<ManagedExpiryWire>,
    #[serde(default)]
    pub(crate) partition_key: Option<Value>,
    #[serde(default)]
    pub(crate) priority: Option<String>,
    #[serde(default)]
    pub(crate) source_scheme: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub(crate) enum ManagedExpiryWire {
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ManagedSession {
    pub(crate) target_url: String,
    pub(crate) allowed_hosts: Vec<String>,
    pub(crate) identity: Option<ManagedSessionIdentity>,
    cookies: Vec<ManagedCookie>,
}

#[derive(Debug, Clone, PartialEq)]
struct ManagedCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    same_site: Option<String>,
    expires: Option<f64>,
    partition_key: Option<Value>,
    priority: Option<String>,
    source_scheme: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum ManagedCdpError {
    #[error("托管会话标识或凭据版本无效")]
    SessionIdentityInvalid,
    #[error("托管平台地址无效")]
    TargetUrlInvalid,
    #[error("托管平台地址不在服务端允许域名内")]
    TargetHostNotAllowed,
    #[error("托管平台地址与服务端会话不一致")]
    TargetUrlMismatch,
    #[error("托管 Cookie 域名无效")]
    CookieDomainInvalid,
    #[error("托管 Cookie 域名不在服务端允许域名内")]
    CookieDomainNotAllowed,
    #[error("托管 Cookie 名称无效")]
    CookieNameInvalid,
    #[error("托管 Cookie 值无效")]
    CookieValueInvalid,
    #[error("托管 Cookie 路径无效")]
    CookiePathInvalid,
    #[error("托管 Cookie SameSite 属性无效")]
    CookieSameSiteInvalid,
    #[error("托管 Cookie 过期时间无效")]
    CookieExpiryInvalid,
    #[error("托管 Cookie 优先级无效")]
    CookiePriorityInvalid,
    #[error("托管 Cookie 来源协议无效")]
    CookieSourceSchemeInvalid,
    #[error("托管 Cookie 分区键无效")]
    CookiePartitionKeyInvalid,
    #[error("托管浏览器没有唯一平台页面")]
    TargetMissing,
    #[error("托管浏览器存在多个平台页面")]
    MultipleTargets,
    #[error("托管浏览器调试连接失败：{0}")]
    Connect(String),
    #[error("托管浏览器调试传输失败：{0}")]
    Transport(String),
    #[error("托管浏览器拒绝命令：{0}")]
    Command(String),
    #[error("托管浏览器响应格式无效")]
    InvalidResponse,
    #[error("等待托管浏览器响应超时")]
    Timeout,
}

fn default_cookie_path() -> String {
    "/".into()
}

/// Validate the server-provided target and cookie domains before any CDP write.
pub(crate) fn validate_session(
    wire: ManagedSessionWire,
) -> Result<ManagedSession, ManagedCdpError> {
    let target =
        Url::parse(wire.target_url.trim()).map_err(|_| ManagedCdpError::TargetUrlInvalid)?;
    if !matches!(target.scheme(), "http" | "https")
        || target.host_str().is_none()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.as_str().chars().any(char::is_control)
    {
        return Err(ManagedCdpError::TargetUrlInvalid);
    }

    let allowed_hosts = normalize_allowed_hosts(&wire.allowed_hosts)?;
    let target_host = target
        .host_str()
        .ok_or(ManagedCdpError::TargetUrlInvalid)?
        .to_ascii_lowercase();
    if !allowed_hosts
        .iter()
        .any(|allowed| host_matches_pattern(&target_host, allowed))
    {
        return Err(ManagedCdpError::TargetHostNotAllowed);
    }

    let cookies = wire
        .cookies
        .into_iter()
        .map(|cookie| validate_cookie(cookie, &allowed_hosts))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ManagedSession {
        target_url: target.to_string(),
        allowed_hosts,
        identity: None,
        cookies,
    })
}

pub(crate) fn managed_session_from_bootstrap(
    target_url: String,
    bootstrap: ManagedBootstrapWire,
) -> Result<ManagedSession, ManagedCdpError> {
    // The desktop launch path parses the platform URL before this check, so a
    // root URL may gain a trailing slash (`https://host` → `https://host/`).
    // Compare parsed canonical URLs to avoid rejecting an otherwise identical
    // server response while still rejecting a different path, query or host.
    let expected = Url::parse(target_url.trim())
        .map_err(|_| ManagedCdpError::TargetUrlInvalid)?
        .to_string();
    let received = Url::parse(bootstrap.target_url.trim())
        .map_err(|_| ManagedCdpError::TargetUrlInvalid)?
        .to_string();
    if expected != received {
        return Err(ManagedCdpError::TargetUrlMismatch);
    }
    let identity = ManagedSessionIdentity::from_bootstrap(&bootstrap)?;
    let mut session = validate_session(ManagedSessionWire {
        target_url: received,
        allowed_hosts: bootstrap.allowed_hosts,
        cookies: bootstrap.cookie_bundle,
    })?;
    session.identity = Some(identity);
    Ok(session)
}

fn normalize_allowed_hosts(hosts: &[String]) -> Result<Vec<String>, ManagedCdpError> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(hosts.len());
    for host in hosts {
        let normalized_host = normalize_host(host).ok_or(ManagedCdpError::TargetHostNotAllowed)?;
        if seen.insert(normalized_host.clone()) {
            normalized.push(normalized_host);
        }
    }
    if normalized.is_empty() {
        return Err(ManagedCdpError::TargetHostNotAllowed);
    }
    Ok(normalized)
}

fn normalize_host(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let host = trimmed.strip_prefix('.').unwrap_or(trimmed);
    if host.is_empty()
        || host.ends_with('.')
        || host
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        || host.contains('/')
        || host.contains('@')
        || host.contains('?')
        || host.contains('#')
        || host.contains('*')
    {
        return None;
    }
    let parsed = Url::parse(&format!("https://{host}/")).ok()?;
    if parsed.username() != "" || parsed.password().is_some() || parsed.port().is_some() {
        return None;
    }
    Some(parsed.host_str()?.to_ascii_lowercase())
}

fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

fn domain_is_within_allowlist(domain: &str, allowed_hosts: &[String]) -> bool {
    allowed_hosts
        .iter()
        .any(|allowed| domain == allowed || domain.ends_with(&format!(".{allowed}")))
}

fn validate_cookie(
    cookie: ManagedCookieWire,
    allowed_hosts: &[String],
) -> Result<ManagedCookie, ManagedCdpError> {
    if cookie.name.is_empty()
        || cookie.name.len() > 256
        || cookie.name.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(
                    byte,
                    b'(' | b')'
                        | b'<'
                        | b'>'
                        | b'@'
                        | b','
                        | b';'
                        | b':'
                        | b'\\'
                        | b'"'
                        | b'/'
                        | b'['
                        | b']'
                        | b'?'
                        | b'='
                        | b'{'
                        | b'}'
                )
        })
    {
        return Err(ManagedCdpError::CookieNameInvalid);
    }
    if cookie.value.len() > 16 * 1024 || cookie.value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(ManagedCdpError::CookieValueInvalid);
    }
    if cookie.path.is_empty()
        || cookie.path.len() > 4096
        || !cookie.path.starts_with('/')
        || cookie.path.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ManagedCdpError::CookiePathInvalid);
    }

    let domain_has_dot = cookie.domain.trim_start().starts_with('.');
    let domain = normalize_host(&cookie.domain).ok_or(ManagedCdpError::CookieDomainInvalid)?;
    if !domain_is_within_allowlist(&domain, allowed_hosts) {
        return Err(ManagedCdpError::CookieDomainNotAllowed);
    }

    let same_site = cookie
        .same_site
        .as_deref()
        .map(normalize_same_site)
        .transpose()?;
    let expires = cookie.expires_at.as_ref().map(parse_expiry).transpose()?;
    let priority = cookie
        .priority
        .as_deref()
        .map(normalize_priority)
        .transpose()?;
    let source_scheme = cookie
        .source_scheme
        .as_deref()
        .map(normalize_source_scheme)
        .transpose()?;
    if let Some(partition_key) = cookie.partition_key.as_ref() {
        if !partition_key.is_object() {
            return Err(ManagedCdpError::CookiePartitionKeyInvalid);
        }
    }

    Ok(ManagedCookie {
        name: cookie.name,
        value: cookie.value,
        domain: if domain_has_dot {
            format!(".{domain}")
        } else {
            domain
        },
        path: cookie.path,
        secure: cookie.secure,
        http_only: cookie.http_only,
        same_site,
        expires,
        partition_key: cookie.partition_key,
        priority,
        source_scheme,
    })
}

fn normalize_same_site(value: &str) -> Result<String, ManagedCdpError> {
    match value.to_ascii_lowercase().as_str() {
        "none" => Ok("None".into()),
        "lax" => Ok("Lax".into()),
        "strict" => Ok("Strict".into()),
        _ => Err(ManagedCdpError::CookieSameSiteInvalid),
    }
}

fn normalize_priority(value: &str) -> Result<String, ManagedCdpError> {
    match value.to_ascii_lowercase().as_str() {
        "low" => Ok("Low".into()),
        "medium" => Ok("Medium".into()),
        "high" => Ok("High".into()),
        _ => Err(ManagedCdpError::CookiePriorityInvalid),
    }
}

fn normalize_source_scheme(value: &str) -> Result<String, ManagedCdpError> {
    match value.to_ascii_lowercase().as_str() {
        "secure" => Ok("Secure".into()),
        "nonsecure" => Ok("NonSecure".into()),
        "unset" => Ok("Unset".into()),
        _ => Err(ManagedCdpError::CookieSourceSchemeInvalid),
    }
}

fn parse_expiry(value: &ManagedExpiryWire) -> Result<f64, ManagedCdpError> {
    let seconds = match value {
        ManagedExpiryWire::Number(seconds) => *seconds,
        ManagedExpiryWire::Text(text) => parse_rfc3339_seconds(text),
    };
    if seconds.is_finite() && seconds >= 0.0 {
        Ok(seconds)
    } else {
        Err(ManagedCdpError::CookieExpiryInvalid)
    }
}

/// Parse the RFC3339 form used by the server without adding a date dependency.
fn parse_rfc3339_seconds(value: &str) -> f64 {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return f64::NAN;
    }
    let number = |start: usize, end: usize| -> Option<i64> { value.get(start..end)?.parse().ok() };
    let Some((year, month, day, hour, minute, second)) = number(0, 4)
        .zip(number(5, 7))
        .zip(number(8, 10))
        .zip(number(11, 13))
        .zip(number(14, 16))
        .zip(number(17, 19))
        .map(|(((((year, month), day), hour), minute), second)| {
            (year, month, day, hour, minute, second)
        })
    else {
        return f64::NAN;
    };
    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return f64::NAN;
    }

    let mut index = 19;
    let mut fraction = 0.0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if start == index {
            return f64::NAN;
        }
        let digits = &value[start..index];
        let parsed = match digits.parse::<f64>() {
            Ok(parsed) => parsed,
            Err(_) => return f64::NAN,
        };
        fraction = parsed / 10_f64.powi(digits.len() as i32);
    }
    let offset = match bytes.get(index..) {
        Some(b"Z") => 0_i64,
        Some([sign, hour_tens, hour_units, b':', minute_tens, minute_units])
            if (*sign == b'+' || *sign == b'-')
                && hour_tens.is_ascii_digit()
                && hour_units.is_ascii_digit()
                && minute_tens.is_ascii_digit()
                && minute_units.is_ascii_digit() =>
        {
            let hours = i64::from(hour_tens - b'0') * 10 + i64::from(hour_units - b'0');
            let minutes = i64::from(minute_tens - b'0') * 10 + i64::from(minute_units - b'0');
            if hours > 23 || minutes > 59 {
                return f64::NAN;
            }
            let total = hours * 3600 + minutes * 60;
            if *sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return f64::NAN,
    };
    let days = days_from_civil(year, month, day);
    (days * 86_400 + hour * 3_600 + minute * 60 + second - offset) as f64 + fraction
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

// Howard Hinnant's civil-date algorithm, returning days since 1970-01-01.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
pub(crate) fn network_set_cookies_command(session: &ManagedSession) -> Value {
    let cookies = session
        .cookies
        .iter()
        .map(|cookie| {
            let mut value = json!({
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "secure": cookie.secure,
                "httpOnly": cookie.http_only,
            });
            if let Some(same_site) = &cookie.same_site {
                value["sameSite"] = Value::String(same_site.clone());
            }
            if let Some(expires) = cookie.expires {
                value["expires"] = json!(expires);
            }
            if let Some(partition_key) = &cookie.partition_key {
                value["partitionKey"] = partition_key.clone();
            }
            if let Some(priority) = &cookie.priority {
                value["priority"] = Value::String(priority.clone());
            }
            if let Some(source_scheme) = &cookie.source_scheme {
                value["sourceScheme"] = Value::String(source_scheme.clone());
            }
            value
        })
        .collect::<Vec<_>>();
    json!({
        "id": SET_COOKIES_COMMAND_ID,
        "method": "Network.setCookies",
        "params": {"cookies": cookies},
    })
}

#[cfg(test)]
pub(crate) fn page_navigate_command(session: &ManagedSession) -> Value {
    json!({
        "id": NAVIGATE_COMMAND_ID,
        "method": "Page.navigate",
        "params": {"url": session.target_url},
    })
}

/// Inject a validated managed session into the one existing page target.
///
/// The browser must already have exactly one page target.  This function never
/// creates a target and never evaluates page JavaScript.  Cookie installation
/// and navigation use separate short-lived control connections so the fixed
/// command IDs remain easy to audit and the activity collector's read-only
/// connection is never reused.
pub(crate) async fn inject_session(
    endpoint: &DevToolsEndpoint,
    session: &ManagedSession,
) -> Result<(), ManagedCdpError> {
    let mut navigation_socket = connect(endpoint).await?;
    let targets = send_command(
        &mut navigation_socket,
        TARGETS_COMMAND_ID,
        "Target.getTargets",
        json!({}),
        None,
    )
    .await?;
    let target_id = select_single_target(&targets, &session.allowed_hosts)?;
    let attach = send_command(
        &mut navigation_socket,
        ATTACH_COMMAND_ID,
        "Target.attachToTarget",
        json!({"targetId": target_id, "flatten": true}),
        None,
    )
    .await?;
    let attached_session = attach
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or(ManagedCdpError::InvalidResponse)?
        .to_string();

    send_command(
        &mut navigation_socket,
        SET_COOKIES_COMMAND_ID,
        "Network.setCookies",
        json!({"cookies": session_cookie_values(session)}),
        Some(&attached_session),
    )
    .await?;

    let navigate = send_command(
        &mut navigation_socket,
        NAVIGATE_COMMAND_ID,
        "Page.navigate",
        json!({"url": session.target_url}),
        Some(&attached_session),
    )
    .await;
    let detach = send_command(
        &mut navigation_socket,
        DETACH_COMMAND_ID,
        "Target.detachFromTarget",
        json!({"sessionId": attached_session}),
        None,
    )
    .await;
    navigate?;
    detach.map(|_| ())
}

fn session_cookie_values(session: &ManagedSession) -> Vec<Value> {
    session
        .cookies
        .iter()
        .map(|cookie| {
            let mut value = json!({
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "secure": cookie.secure,
                "httpOnly": cookie.http_only,
            });
            if let Some(same_site) = &cookie.same_site {
                value["sameSite"] = Value::String(same_site.clone());
            }
            if let Some(expires) = cookie.expires {
                value["expires"] = json!(expires);
            }
            if let Some(partition_key) = &cookie.partition_key {
                value["partitionKey"] = partition_key.clone();
            }
            if let Some(priority) = &cookie.priority {
                value["priority"] = Value::String(priority.clone());
            }
            if let Some(source_scheme) = &cookie.source_scheme {
                value["sourceScheme"] = Value::String(source_scheme.clone());
            }
            value
        })
        .collect()
}

/// A platform-specific logout signal, not an authentication/security boundary.
/// Unknown platforms do not inherit a generic substring rule.
///
/// 同一套策略还认「主 frame 落回登录页」：托管凭据一旦不再被平台接受，
/// `/login` 就不再 302 到工作台，而是渲染出可用的登录表单——窗口里此时
/// 没有任何东西拦着用户输入自己的账号。这条路由因此是失效信号。
#[derive(Debug, Clone)]
struct LogoutPolicy {
    endpoint: Url,
    login_route: Url,
}

impl LogoutPolicy {
    fn for_platform(target_url: &str) -> Option<Self> {
        let target = Url::parse(target_url).ok()?;
        if target.scheme() != "https"
            || target.host_str() != Some("agent.oceanengine.com")
            || target.port_or_known_default() != Some(443)
        {
            return None;
        }
        Some(Self {
            endpoint: Url::parse("https://sso.oceanengine.com/account/page/service/sso_logout")
                .expect("fixed Ark logout endpoint"),
            login_route: Url::parse("https://agent.oceanengine.com/login")
                .expect("fixed Ark login route"),
        })
    }

    fn matches(&self, value: &str) -> bool {
        let Ok(url) = Url::parse(value) else {
            return false;
        };
        url.username().is_empty()
            && url.password().is_none()
            && url.origin() == self.endpoint.origin()
            && url.path() == self.endpoint.path()
    }

    fn login_guard_script(&self) -> String {
        include_str!("managed_cdp/login_guard.js").replace(
            "__VESTUS_LOGIN_ROUTE__",
            &json!({
                "origin": self.login_route.origin().ascii_serialization(),
                "path": self.login_route.path(),
            })
            .to_string(),
        )
    }

    /// 登录页本身及其子路径（`/login`、`/login/xxx`）；查询串不计入。
    fn matches_login(&self, value: &str) -> bool {
        let Ok(url) = Url::parse(value) else {
            return false;
        };
        if !url.username().is_empty()
            || url.password().is_some()
            || url.origin() != self.login_route.origin()
        {
            return false;
        }
        let path = url.path();
        let login = self.login_route.path();
        path == login
            || path
                .strip_prefix(login)
                .is_some_and(|rest| rest.starts_with('/'))
    }
}

/// 主 frame 落到登录页后等待自动跳转；固定脚本在整个等待窗口内锁住登录交互。
const LOGIN_SETTLE: Duration = Duration::from_secs(4);
const WATCH_HEARTBEAT: Duration = Duration::from_secs(5);

struct LogoutDetector {
    policy: LogoutPolicy,
    /// 每个已接管的标签页会话 -> 其主 frame id。只有这里登记过的会话会被
    /// 处理；复制标签页、新开标签页与首个标签页一视同仁。
    sessions: HashMap<String, Option<String>>,
    pending_login: HashMap<String, tokio::time::Instant>,
    detected: bool,
}

impl LogoutDetector {
    fn new(policy: LogoutPolicy) -> Self {
        Self {
            policy,
            sessions: HashMap::new(),
            pending_login: HashMap::new(),
            detected: false,
        }
    }

    fn has_tracked_session(&self) -> bool {
        !self.sessions.is_empty()
    }

    /// 有标签页停在登录页时返回其自愈截止时刻；调用方据此把等待变成限时等待。
    fn login_deadline(&self) -> Option<tokio::time::Instant> {
        self.pending_login
            .values()
            .map(|since| *since + LOGIN_SETTLE)
            .min()
    }

    /// 截止时刻已到：登录页还没跳走，托管凭据判定失效。
    fn login_expired_at(&self, now: tokio::time::Instant) -> bool {
        self.login_deadline()
            .is_some_and(|deadline| now >= deadline)
    }

    /// 登记一个页面会话；返回 `Some` 表示这是新接管的标签页，还需要为它
    /// 启用 `Page` 域并播种 frame tree。
    fn observe_attach(&mut self, event: &Value) -> Option<String> {
        if event.get("method").and_then(Value::as_str) != Some("Target.attachedToTarget") {
            return None;
        }
        if event
            .pointer("/params/targetInfo/type")
            .and_then(Value::as_str)
            != Some("page")
        {
            return None;
        }
        let session_id = event.pointer("/params/sessionId").and_then(Value::as_str)?;
        if self.sessions.contains_key(session_id) {
            return None;
        }
        self.sessions.insert(session_id.to_string(), None);
        Some(session_id.to_string())
    }

    fn observe(&mut self, event: &Value) {
        match event.get("method").and_then(Value::as_str) {
            Some("Target.attachedToTarget") => {
                self.observe_attach(event);
            }
            Some("Target.detachedFromTarget") => {
                if let Some(session_id) = event.pointer("/params/sessionId").and_then(Value::as_str)
                {
                    self.sessions.remove(session_id);
                    // 关掉的标签页只移除自己的等待，不影响其他登录页。
                    self.pending_login.remove(session_id);
                }
            }
            _ => {
                let Some(session_id) = event.get("sessionId").and_then(Value::as_str) else {
                    return;
                };
                // 未登记的会话（采集器等其他连接）一律忽略。
                if !self.sessions.contains_key(session_id) {
                    return;
                }
                match event.get("method").and_then(Value::as_str) {
                    Some("Page.frameNavigated") => {
                        if let Some(frame) = event.pointer("/params/frame") {
                            if frame.get("parentId").is_none() {
                                self.observe_main_frame(session_id, frame);
                            }
                        }
                    }
                    Some("Page.navigatedWithinDocument") => {
                        let main_frame_id =
                            self.sessions.get(session_id).and_then(Option::as_deref);
                        if let Some(main_frame_id) = main_frame_id {
                            if event.pointer("/params/frameId").and_then(Value::as_str)
                                == Some(main_frame_id)
                            {
                                self.observe_url(
                                    session_id,
                                    event.pointer("/params/url").and_then(Value::as_str),
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn observe_main_frame(&mut self, session_id: &str, frame: &Value) {
        if !self.sessions.contains_key(session_id) {
            return;
        }
        if let Some(id) = frame
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            if let Some(tracked) = self.sessions.get_mut(session_id) {
                *tracked = Some(id.to_string());
            }
            self.observe_url(session_id, frame.get("url").and_then(Value::as_str));
        }
    }

    fn observe_url(&mut self, session_id: &str, url: Option<&str>) {
        let Some(url) = url else { return };
        if self.policy.matches(url) {
            self.detected = true;
            return;
        }
        if self.policy.matches_login(url) {
            // 每个标签首次落地各自计时；另一个标签的跳转不能延长或清掉它。
            self.pending_login
                .entry(session_id.to_string())
                .or_insert_with(tokio::time::Instant::now);
        } else {
            self.pending_login.remove(session_id);
        }
    }
}

#[path = "managed_cdp/watch.rs"]
mod watch;
#[cfg(test)]
use watch::prepare_logout_watch_with_policy;
pub(crate) use watch::{prepare_logout_watch, LogoutWatch};

type ManagedSocket = WebSocketStream<TcpStream>;

/// 命令自增 ID：登出监听会随标签页开合动态发送 Page.enable/getFrameTree，
/// 不再使用固定序号。
static NEXT_COMMAND_ID: AtomicI64 = AtomicI64::new(100);

fn next_command_id() -> i64 {
    NEXT_COMMAND_ID.fetch_add(1, Ordering::Relaxed)
}

/// Cookie 注入仍要求“恰好一个页面目标”：多页面或陌生域名页面的环境直接拒绝
/// 注入，防止把会话 Cookie 装进不受信页面。登出监听不受此限制——它只观察。
fn select_single_target(
    result: &Value,
    allowed_hosts: &[String],
) -> Result<String, ManagedCdpError> {
    let targets = result
        .get("targetInfos")
        .and_then(Value::as_array)
        .ok_or(ManagedCdpError::InvalidResponse)?;
    let pages = targets
        .iter()
        .filter(|target| target.get("type").and_then(Value::as_str) == Some("page"))
        .collect::<Vec<_>>();
    if pages.is_empty() {
        return Err(ManagedCdpError::TargetMissing);
    }
    if pages.len() > 1 {
        return Err(ManagedCdpError::MultipleTargets);
    }
    let target = pages[0];
    let target_id = target
        .get("targetId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(ManagedCdpError::InvalidResponse)?;
    let current_url = target
        .get("url")
        .and_then(Value::as_str)
        .ok_or(ManagedCdpError::InvalidResponse)?;
    if current_url != "about:blank" {
        let current = Url::parse(current_url).map_err(|_| ManagedCdpError::TargetHostNotAllowed)?;
        let host = current
            .host_str()
            .ok_or(ManagedCdpError::TargetHostNotAllowed)?
            .to_ascii_lowercase();
        if !matches!(current.scheme(), "http" | "https")
            || !allowed_hosts
                .iter()
                .any(|allowed| host_matches_pattern(&host, allowed))
        {
            return Err(ManagedCdpError::TargetHostNotAllowed);
        }
    }
    Ok(target_id.to_string())
}

async fn connect(endpoint: &DevToolsEndpoint) -> Result<ManagedSocket, ManagedCdpError> {
    let stream = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect(("127.0.0.1", endpoint.port)),
    )
    .await
    .map_err(|_| ManagedCdpError::Connect("等待连接超时".into()))?
    .map_err(|error| ManagedCdpError::Connect(error.to_string()))?;
    let _ = stream.set_nodelay(true);
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES));
    let (socket, _) = client_async_with_config(endpoint.websocket_url(), stream, Some(config))
        .await
        .map_err(|error| ManagedCdpError::Connect(error.to_string()))?;
    Ok(socket)
}

async fn send_command(
    socket: &mut ManagedSocket,
    id: i64,
    method: &str,
    params: Value,
    session_id: Option<&str>,
) -> Result<Value, ManagedCdpError> {
    send_command_observing(socket, id, method, params, session_id, |_| {}).await
}

async fn send_command_observing(
    socket: &mut ManagedSocket,
    id: i64,
    method: &str,
    params: Value,
    session_id: Option<&str>,
    mut observe: impl FnMut(&Value),
) -> Result<Value, ManagedCdpError> {
    let mut message = json!({"id": id, "method": method, "params": params});
    if let Some(session_id) = session_id {
        message["sessionId"] = Value::String(session_id.to_string());
    }
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .map_err(|error| ManagedCdpError::Transport(error.to_string()))?;
    let exchange = async {
        while let Some(frame) = socket.next().await {
            let frame = frame.map_err(|error| ManagedCdpError::Transport(error.to_string()))?;
            let Message::Text(text) = frame else {
                continue;
            };
            let response: Value =
                serde_json::from_str(&text).map_err(|_| ManagedCdpError::InvalidResponse)?;
            if response.get("id").and_then(Value::as_i64) != Some(id) {
                observe(&response);
                continue;
            }
            if let Some(error) = response.get("error") {
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误");
                return Err(ManagedCdpError::Command(detail.to_string()));
            }
            return response
                .get("result")
                .cloned()
                .ok_or(ManagedCdpError::InvalidResponse);
        }
        Err(ManagedCdpError::Transport("调试通道在回执之前关闭".into()))
    };
    timeout(COMMAND_TIMEOUT, exchange)
        .await
        .map_err(|_| ManagedCdpError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session_json() -> serde_json::Value {
        json!({
            "targetUrl": "https://agent.oceanengine.com/workbench",
            "allowedHosts": ["agent.oceanengine.com", ".oceanengine.com"],
            "cookies": [{
                "name": "sessionid",
                "value": "opaque-token",
                "domain": ".oceanengine.com",
                "path": "/",
                "secure": true,
                "httpOnly": true,
                "sameSite": "Lax",
                "expiresAt": 1762084800.0
            }]
        })
    }

    #[test]
    fn accepts_consume_bootstrap_wire_without_exposing_metadata_to_commands() {
        let bootstrap = json!({
            "sessionId": "42",
            "managedAccountId": 9,
            "credentialVersion": 7,
            "targetUrl": "https://agent.oceanengine.com/workbench",
            "cookieBundle": session_json()["cookies"].clone(),
            "allowedHosts": ["agent.oceanengine.com", ".oceanengine.com"],
            "expiresAt": "2026-11-02T12:00:00Z"
        });
        let wire: ManagedBootstrapWire = serde_json::from_value(bootstrap).unwrap();
        let session =
            managed_session_from_bootstrap("https://agent.oceanengine.com/workbench".into(), wire)
                .unwrap();

        assert_eq!(
            session.target_url,
            "https://agent.oceanengine.com/workbench"
        );
        assert_eq!(
            network_set_cookies_command(&session)["params"]["cookies"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn accepts_equivalent_root_url_with_trailing_slash() {
        let mut bootstrap = json!({
            "sessionId": "42",
            "managedAccountId": 9,
            "credentialVersion": 7,
            "targetUrl": "https://agent.oceanengine.com",
            "cookieBundle": session_json()["cookies"].clone(),
            "allowedHosts": ["agent.oceanengine.com", ".oceanengine.com"],
            "expiresAt": "2026-11-02T12:00:00Z"
        });
        // The server may store a root platform URL without the slash while
        // Url::parse on the desktop side canonicalizes it with one.
        let wire: ManagedBootstrapWire = serde_json::from_value(bootstrap.take()).unwrap();
        let session =
            managed_session_from_bootstrap("https://agent.oceanengine.com/".into(), wire).unwrap();
        assert_eq!(session.target_url, "https://agent.oceanengine.com/");
    }

    #[test]
    fn validates_cookie_wire_and_renders_fixed_set_cookie_command() {
        let wire: ManagedSessionWire = serde_json::from_value(session_json()).unwrap();
        let session = validate_session(wire).unwrap();
        let command = network_set_cookies_command(&session);

        assert_eq!(
            command,
            json!({
                "id": 1,
                "method": "Network.setCookies",
                "params": {
                    "cookies": [{
                        "name": "sessionid",
                        "value": "opaque-token",
                        "domain": ".oceanengine.com",
                        "path": "/",
                        "secure": true,
                        "httpOnly": true,
                        "sameSite": "Lax",
                        "expires": 1762084800.0
                    }]
                }
            })
        );
    }

    #[test]
    fn renders_navigation_only_for_the_validated_target_url() {
        let wire: ManagedSessionWire = serde_json::from_value(session_json()).unwrap();
        let session = validate_session(wire).unwrap();

        assert_eq!(
            page_navigate_command(&session),
            json!({
                "id": 2,
                "method": "Page.navigate",
                "params": {"url": "https://agent.oceanengine.com/workbench"}
            })
        );
    }

    #[test]
    fn rejects_target_outside_server_allowlist() {
        let mut wire: ManagedSessionWire = serde_json::from_value(session_json()).unwrap();
        wire.target_url = "https://evil.example/".into();

        assert_eq!(
            validate_session(wire),
            Err(ManagedCdpError::TargetHostNotAllowed)
        );
    }

    #[test]
    fn rejects_cookie_domain_outside_server_allowlist() {
        let mut wire: ManagedSessionWire = serde_json::from_value(session_json()).unwrap();
        wire.cookies[0].domain = ".evil.example".into();

        assert_eq!(
            validate_session(wire),
            Err(ManagedCdpError::CookieDomainNotAllowed)
        );
    }

    #[test]
    fn requires_boundary_aware_host_matching() {
        let mut wire: ManagedSessionWire = serde_json::from_value(session_json()).unwrap();
        wire.allowed_hosts = vec!["oceanengine.com".into()];
        wire.target_url = "https://not-oceanengine.com/".into();

        assert_eq!(
            validate_session(wire),
            Err(ManagedCdpError::TargetHostNotAllowed)
        );
    }

    #[test]
    fn rejects_unsupported_same_site_value() {
        let mut wire: ManagedSessionWire = serde_json::from_value(session_json()).unwrap();
        wire.cookies[0].same_site = Some("Strict-Transport".into());

        assert_eq!(
            validate_session(wire),
            Err(ManagedCdpError::CookieSameSiteInvalid)
        );
    }

    #[test]
    fn logout_policy_matches_only_the_exact_platform_endpoint() {
        let policy = LogoutPolicy::for_platform("https://agent.oceanengine.com/").unwrap();
        assert!(policy.matches(
            "https://sso.oceanengine.com/account/page/service/sso_logout?aid=1968&csrf=test"
        ));
        for url in [
            "https://example.com/logout",
            "https://agent.oceanengine.com/?return=logout",
            "https://agent.oceanengine.com/docs/logout-guide",
            "https://sso.oceanengine.com.evil.test/account/page/service/sso_logout",
            "https://sso.oceanengine.com/account/page/service/sso_logout_help",
            "https://sso.oceanengine.com/?next=/account/page/service/sso_logout",
            "https://sso.oceanengine.com:444/account/page/service/sso_logout",
            "https://user@sso.oceanengine.com/account/page/service/sso_logout",
            "http://sso.oceanengine.com/account/page/service/sso_logout",
            "about:blank#logout",
        ] {
            assert!(!policy.matches(url), "must ignore {url}");
        }
        assert!(LogoutPolicy::for_platform("https://other.example/").is_none());
    }

    fn logout_detector() -> LogoutDetector {
        let mut detector = LogoutDetector::new(
            LogoutPolicy::for_platform("https://agent.oceanengine.com/").unwrap(),
        );
        detector.observe(&json!({
            "method": "Target.attachedToTarget",
            "params": {"sessionId": "attached", "targetInfo": {"type": "page"}},
        }));
        detector
    }

    fn attach(detector: &mut LogoutDetector, session_id: &str) {
        detector.observe(&json!({
            "method": "Target.attachedToTarget",
            "params": {"sessionId": session_id, "targetInfo": {"type": "page"}},
        }));
    }

    #[test]
    fn logout_detector_ignores_untracked_sessions_then_tracks_new_tabs() {
        let url = "https://sso.oceanengine.com/account/page/service/sso_logout";
        let mut detector = logout_detector();
        // 未登记会话（如采集器等其他连接）与子 frame、同文档子 frame 一律忽略。
        for event in [
            json!({"method": "Page.frameNavigated", "sessionId": "other",
                   "params": {"frame": {"id": "main", "url": url}}}),
            json!({"method": "Page.frameNavigated", "sessionId": "attached",
                   "params": {"frame": {"id": "child", "parentId": "main", "url": url}}}),
            json!({"method": "Page.navigatedWithinDocument", "sessionId": "attached",
                   "params": {"frameId": "child", "url": url}}),
        ] {
            detector.observe(&event);
            assert!(!detector.detected);
        }
        detector.observe(
            &json!({"method": "Page.frameNavigated", "sessionId": "attached",
                                "params": {"frame": {"id": "main", "url": url}}}),
        );
        assert!(detector.detected);

        // 复制/新开的标签页登记后同样是主战场：另一个标签页登出也必须命中。
        let mut detector = logout_detector();
        attach(&mut detector, "duplicated");
        detector.observe(
            &json!({"method": "Page.frameNavigated", "sessionId": "duplicated",
                                "params": {"frame": {"id": "dup-main", "url": url}}}),
        );
        assert!(detector.detected);
    }

    #[test]
    fn logout_detector_tracks_the_main_frame_for_same_document_navigation() {
        let mut detector = logout_detector();
        detector.observe(
            &json!({"method": "Page.frameNavigated", "sessionId": "attached",
            "params": {"frame": {"id": "new-main", "url": "https://agent.oceanengine.com/"}}}),
        );
        let url = "https://sso.oceanengine.com/account/page/service/sso_logout";
        detector.observe(
            &json!({"method": "Page.navigatedWithinDocument", "sessionId": "attached",
                                "params": {"frameId": "main", "url": url}}),
        );
        assert!(!detector.detected);
        detector.observe(
            &json!({"method": "Page.navigatedWithinDocument", "sessionId": "attached",
                                "params": {"frameId": "new-main", "url": url}}),
        );
        assert!(detector.detected);
    }

    #[test]
    fn detached_tab_is_dropped_and_stops_being_observed() {
        let url = "https://sso.oceanengine.com/account/page/service/sso_logout";
        let mut detector = logout_detector();
        detector.observe(&json!({"method": "Target.detachedFromTarget",
                                "params": {"sessionId": "attached"}}));
        assert!(!detector.has_tracked_session());
        detector.observe(
            &json!({"method": "Page.frameNavigated", "sessionId": "attached",
                                "params": {"frame": {"id": "main", "url": url}}}),
        );
        assert!(!detector.detected);
    }

    #[test]
    fn non_page_targets_are_never_tracked() {
        let mut detector = LogoutDetector::new(
            LogoutPolicy::for_platform("https://agent.oceanengine.com/").unwrap(),
        );
        detector.observe(&json!({
            "method": "Target.attachedToTarget",
            "params": {"sessionId": "worker", "targetInfo": {"type": "service_worker"}},
        }));
        assert!(!detector.has_tracked_session());
    }

    #[test]
    fn bootstrap_identity_is_required_and_never_enters_the_cookie_command() {
        let bootstrap = json!({
            "sessionId": "42", "managedAccountId": 9, "credentialVersion": 7,
            "targetUrl": "https://agent.oceanengine.com/workbench",
            "cookieBundle": session_json()["cookies"].clone(),
            "allowedHosts": ["oceanengine.com"], "expiresAt": "2026-11-02T12:00:00Z"
        });
        let wire = serde_json::from_value(bootstrap.clone()).unwrap();
        let session =
            managed_session_from_bootstrap("https://agent.oceanengine.com/workbench".into(), wire)
                .unwrap();
        assert_eq!(session.identity.as_ref().unwrap().credential_version, 7);
        assert_eq!(session.identity.as_ref().unwrap().session_id, "42");
        let command = network_set_cookies_command(&session).to_string();
        assert!(!command.contains("credentialVersion"));
        assert!(!command.contains("sessionId"));
        for (field, value) in [
            ("sessionId", json!("not-a-session")),
            ("sessionId", json!("0")),
            ("sessionId", json!("+42")),
            ("managedAccountId", json!(0)),
            ("credentialVersion", json!(0)),
        ] {
            let mut invalid = bootstrap.clone();
            invalid[field] = value;
            let wire = serde_json::from_value(invalid).unwrap();
            assert_eq!(
                managed_session_from_bootstrap(
                    "https://agent.oceanengine.com/workbench".into(),
                    wire
                ),
                Err(ManagedCdpError::SessionIdentityInvalid)
            );
        }
    }

    #[tokio::test]
    async fn setup_retains_logout_events_before_command_replies() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = DevToolsEndpoint {
            port: listener.local_addr().unwrap().port(),
            browser_path: "/devtools/browser/setup-test".into(),
        };
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            for method in [
                "Target.setDiscoverTargets",
                "Target.setAutoAttach",
                "Target.getTargets",
                "Target.attachToTarget",
                "Page.enable",
                "Page.addScriptToEvaluateOnNewDocument",
                "Page.getFrameTree",
                "Runtime.runIfWaitingForDebugger",
            ] {
                let Message::Text(text) = ws.next().await.unwrap().unwrap() else {
                    panic!("expected command");
                };
                let command: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(command["method"], method);
                let result = match method {
                    "Target.getTargets" => {
                        json!({"targetInfos": [{"targetId": "page", "type": "page", "url": "about:blank"}]})
                    }
                    "Target.attachToTarget" => json!({"sessionId": "attached"}),
                    "Page.addScriptToEvaluateOnNewDocument" => json!({"identifier": "fixed-guard"}),
                    "Page.getFrameTree" => {
                        json!({"frameTree": {"frame": {"id": "main", "url": "https://agent.oceanengine.com/"}}})
                    }
                    _ => json!({}),
                };
                if method == "Page.enable" {
                    // 在回执之前就推登出事件：监听必须保留并识别它。
                    ws.send(Message::Text(json!({"method": "Page.frameNavigated", "sessionId": "attached",
                        "params": {"frame": {"id": "main", "url": "https://sso.oceanengine.com/account/page/service/sso_logout"}}
                    }).to_string().into())).await.unwrap();
                }
                ws.send(Message::Text(
                    json!({"id": command["id"], "result": result})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            }
        });
        let session = validate_session(serde_json::from_value(session_json()).unwrap()).unwrap();
        let watch = prepare_logout_watch(&endpoint, &session)
            .await
            .unwrap()
            .unwrap();
        assert!(watch.wait().await.unwrap());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn duplicated_tab_logout_triggers_the_watch() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = DevToolsEndpoint {
            port: listener.local_addr().unwrap().port(),
            browser_path: "/devtools/browser/duplicate-test".into(),
        };
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            for method in [
                "Target.setDiscoverTargets",
                "Target.setAutoAttach",
                "Target.getTargets",
                "Target.attachToTarget",
                "Page.enable",
                "Page.addScriptToEvaluateOnNewDocument",
                "Page.getFrameTree",
                "Runtime.runIfWaitingForDebugger",
            ] {
                let Message::Text(text) = ws.next().await.unwrap().unwrap() else {
                    panic!("expected command");
                };
                let command: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(command["method"], method);
                let result = match method {
                    "Target.getTargets" => {
                        json!({"targetInfos": [{"targetId": "page", "type": "page", "url": "about:blank"}]})
                    }
                    "Target.attachToTarget" => json!({"sessionId": "first"}),
                    "Page.addScriptToEvaluateOnNewDocument" => json!({"identifier": "fixed-guard"}),
                    "Page.getFrameTree" => {
                        json!({"frameTree": {"frame": {"id": "main", "url": "https://agent.oceanengine.com/workbench"}}})
                    }
                    _ => json!({}),
                };
                ws.send(Message::Text(
                    json!({"id": command["id"], "result": result})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            }
            // 用户复制标签页：auto-attach 送来第二个页面会话。
            ws.send(Message::Text(json!({
                "method": "Target.attachedToTarget",
                "params": {"sessionId": "dup", "targetInfo": {"type": "page", "targetId": "dup-page"}}
            }).to_string().into())).await.unwrap();
            // 复制页登出：必须同样命中。
            for method in [
                "Page.enable",
                "Page.addScriptToEvaluateOnNewDocument",
                "Page.getFrameTree",
                "Runtime.runIfWaitingForDebugger",
            ] {
                let Message::Text(text) = ws.next().await.unwrap().unwrap() else {
                    panic!("expected {method}");
                };
                let command: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(command["method"], method);
                assert_eq!(command["sessionId"], "dup");
                let result = if method == "Page.getFrameTree" {
                    json!({"frameTree": {"frame": {"id": "dup-main", "url": "https://agent.oceanengine.com/workbench"}}})
                } else if method == "Page.addScriptToEvaluateOnNewDocument" {
                    json!({"identifier": "dup-guard"})
                } else {
                    json!({})
                };
                ws.send(Message::Text(
                    json!({"id": command["id"], "result": result})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            }
            ws.send(Message::Text(json!({"method": "Page.frameNavigated", "sessionId": "dup",
                "params": {"frame": {"id": "dup-main", "url": "https://sso.oceanengine.com/account/page/service/sso_logout"}}
            }).to_string().into())).await.unwrap();
        });
        let session = validate_session(serde_json::from_value(session_json()).unwrap()).unwrap();
        let watch = prepare_logout_watch(&endpoint, &session)
            .await
            .unwrap()
            .unwrap();
        assert!(watch.wait().await.unwrap());
        server.await.unwrap();
    }
}

#[cfg(test)]
#[path = "managed_cdp/tests.rs"]
mod integration_tests;
