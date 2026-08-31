//! Desktop-user authentication owned by the Rust process.
//!
//! The React/Tauri WebView is deliberately never given the bearer token. It submits a
//! username and password once, then receives only the serializable user view.
//! The token lives in this module's in-memory state and in the operating
//! system keyring so a desktop session can be restored after an app restart.

use std::{
    net::IpAddr,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use base64::Engine as _;
use reqwest::{Client, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::{browser::BrowserSessionManager, state::AppState};

#[cfg(any(debug_assertions, test))]
const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:8000";
const API_BASE_URL_ENV: &str = "VESTUS_API_BASE_URL";
const COMPILED_API_BASE_URL: Option<&str> = option_env!("VESTUS_API_BASE_URL");
const COMPILED_ALLOW_INSECURE_API: Option<&str> = option_env!("VESTUS_ALLOW_INSECURE_API");
const LOGIN_PATH: &str = "/api/user/auth/login";
const ME_PATH: &str = "/api/user/auth/me";
const LOGOUT_PATH: &str = "/api/user/auth/logout";
const CHANGE_PASSWORD_PATH: &str = "/api/user/auth/change-password";
const DESKTOP_CONFIG_PATH: &str = "/api/user/desktop-config";
const DESKTOP_CONFIG_LEASE_PATH: &str = "/api/user/desktop-config/lease";
const PRODUCT_NAME_PATH: &str = "/api/product";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// The success code of the shared response envelope.
///
/// Mirrors `app.core.api_contract.ApiCode.OK`; every other value carries the
/// HTTP status in its leading digits (`40100` for a 401).
const API_CODE_OK: i64 = 0;

// The bearer token is the only persistent secret owned by the desktop app.
// Proxy credentials remain in Rust memory for the active synchronized session.
const KEYRING_SERVICE: &str = "com.zhixi.vestus";
const KEYRING_ACCOUNT: &str = "vestus.desktop_auth.access_token";

/// The only account shape desktop JavaScript is allowed to receive.
///
/// Fields are explicit rather than flattened so an unexpected sensitive field
/// added by the server can never accidentally cross the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUser {
    pub id: i64,
    pub username: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub company: Option<String>,
    pub status: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub must_change_password: bool,
}

impl DesktopUser {
    fn ensure_desktop_role(self) -> AuthResult<Self> {
        if self.role == "client" {
            Ok(self)
        } else {
            Err(DesktopAuthError::new(
                "wrong_role",
                "该账号不是桌面端用户，请使用管理员分配的桌面账号",
            ))
        }
    }
}

/// Serializable, user-facing command error.  It intentionally carries no
/// request, response, password, or bearer-token data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesktopAuthError {
    pub code: String,
    pub message: String,
}

impl DesktopAuthError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn invalid_response(message: impl Into<String>) -> Self {
        Self::new("invalid_response", message)
    }

    fn state_unavailable() -> Self {
        Self::new("auth_state", "登录状态暂时不可用，请重启桌面端后重试")
    }
}

type AuthResult<T> = Result<T, DesktopAuthError>;

#[derive(Debug, Deserialize)]
struct LoginResponse {
    // The Python API currently emits both spellings.  Separate fields avoid a
    // serde duplicate-field error when both are present in one response.
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default, rename = "accessToken")]
    access_token_camel: Option<String>,
    user: DesktopUser,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProductInfo {
    pub product_name: String,
    #[serde(default)]
    pub logo_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductNameResponse {
    product_name: String,
    #[serde(default)]
    logo_url: Option<String>,
}

fn is_strict_upload_path(path: &str) -> bool {
    let Some(suffix) = path.strip_prefix("/uploads/") else {
        return false;
    };
    let mut segments = suffix.split('/');
    let (Some(year), Some(month), Some(filename), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return false;
    };
    if year.len() != 4
        || !year.bytes().all(|byte| byte.is_ascii_digit())
        || !matches!(
            month,
            "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
        )
    {
        return false;
    }

    let (stem, extension) = filename
        .split_once('.')
        .map_or((filename, None), |(stem, extension)| {
            (stem, Some(extension))
        });
    stem.len() == 32
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        && extension.is_none_or(|extension| {
            !extension.is_empty()
                && extension.len() <= 16
                && extension
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        })
}

/// Resolve one server-owned uploaded asset without allowing JavaScript to
/// choose an arbitrary network origin. New API responses contain only the
/// relative form; an exact legacy absolute URL from the same API base is
/// accepted during rolling upgrades and canonicalized back through that base.
pub(crate) fn resolve_uploaded_asset_url(api_base: &str, value: &str) -> Option<String> {
    let base = Url::parse(api_base.trim()).ok()?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return None;
    }

    let value = value.trim();
    let relative_path = if value.starts_with('/') {
        value.to_string()
    } else {
        let absolute = Url::parse(value).ok()?;
        if !matches!(absolute.scheme(), "http" | "https")
            || absolute.origin() != base.origin()
            || !absolute.username().is_empty()
            || absolute.password().is_some()
            || absolute.query().is_some()
            || absolute.fragment().is_some()
        {
            return None;
        }
        let base_path = base.path().trim_end_matches('/');
        absolute.path().strip_prefix(base_path)?.to_string()
    };

    if !is_strict_upload_path(&relative_path) {
        return None;
    }
    Some(format!(
        "{}{}",
        base.as_str().trim_end_matches('/'),
        relative_path
    ))
}

fn product_info_from_wire(api_base: &str, wire: ProductNameResponse) -> ProductInfo {
    let name = wire.product_name.trim();
    let product_name =
        if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
            "Vestus".to_string()
        } else {
            name.to_string()
        };
    let logo_url = wire
        .logo_url
        .as_deref()
        .and_then(|value| resolve_uploaded_asset_url(api_base, value));
    ProductInfo {
        product_name,
        logo_url,
    }
}

impl LoginResponse {
    fn into_session(self) -> AuthResult<(String, DesktopUser)> {
        let token = match (self.access_token, self.access_token_camel) {
            (Some(snake), Some(camel)) if snake != camel => {
                return Err(DesktopAuthError::invalid_response(
                    "登录响应中的访问令牌不一致",
                ));
            }
            (Some(token), _) | (None, Some(token)) => token,
            (None, None) => {
                return Err(DesktopAuthError::invalid_response("登录响应缺少访问令牌"));
            }
        };

        if token.trim().is_empty() {
            return Err(DesktopAuthError::invalid_response(
                "登录响应缺少有效访问令牌",
            ));
        }

        Ok((token, self.user.ensure_desktop_role()?))
    }
}

#[derive(Serialize)]
struct LoginRequest<'a> {
    username: &'a str,
    password: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest<'a> {
    current_password: &'a str,
    new_password: &'a str,
}

#[derive(Deserialize)]
struct DesktopLeaseResponse {
    lease: String,
}

#[derive(Default)]
struct SessionState {
    token: Option<String>,
    user: Option<DesktopUser>,
    /// Expiry copied from the server-validated signed token payload.
    expires_at_unix: Option<u64>,
    /// Changes on every login/restore/logout so stale async work can be ignored.
    generation: u64,
    /// Server-issued browser profile namespace for the current desktop user.
    /// It is set only after `/api/user/desktop-config` has been validated.
    profile_key: Option<String>,
}

trait CredentialStore: Send + Sync {
    fn load_token(&self) -> Result<Option<String>, String>;
    fn save_token(&self, token: &str) -> Result<(), String>;
    fn delete_token(&self) -> Result<(), String>;
}

struct OsCredentialStore;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl OsCredentialStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl CredentialStore for OsCredentialStore {
    fn load_token(&self) -> Result<Option<String>, String> {
        match Self::entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save_token(&self, token: &str) -> Result<(), String> {
        Self::entry()?
            .set_password(token)
            .map_err(|error| error.to_string())
    }

    fn delete_token(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

// Linux 在 Cargo.toml 里没有 keyring 后端（不想为发布包引入 D-Bus /
// secret-service 运行时依赖），所以这里用进程内存代替系统钥匙串：应用运行
// 期间可以恢复会话，退出后需要重新登录。令牌同样绝不落盘。
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
static PROCESS_TOKEN: Mutex<Option<String>> = Mutex::new(None);

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn process_token() -> Result<MutexGuard<'static, Option<String>>, String> {
    PROCESS_TOKEN
        .lock()
        .map_err(|_| "本地凭据锁已中毒".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl CredentialStore for OsCredentialStore {
    fn load_token(&self) -> Result<Option<String>, String> {
        Ok(process_token()?.clone())
    }

    fn save_token(&self, token: &str) -> Result<(), String> {
        *process_token()? = Some(token.to_string());
        Ok(())
    }

    fn delete_token(&self) -> Result<(), String> {
        *process_token()? = None;
        Ok(())
    }
}

/// Rust-owned desktop authentication state registered through `Tauri::manage`.
#[derive(Clone)]
pub struct DesktopAuthState {
    client: Result<Client, DesktopAuthError>,
    api_base_url: Result<String, DesktopAuthError>,
    session: Arc<Mutex<SessionState>>,
    operation: Arc<tokio::sync::Mutex<()>>,
    credentials: Arc<dyn CredentialStore>,
}

impl Default for DesktopAuthState {
    fn default() -> Self {
        #[cfg(debug_assertions)]
        let raw_base = std::env::var(API_BASE_URL_ENV).unwrap_or_else(|_| {
            COMPILED_API_BASE_URL
                .unwrap_or(DEFAULT_API_BASE_URL)
                .to_string()
        });
        // Production builds pin the service address at compile time. Missing
        // configuration becomes a visible startup/login error instead of
        // silently connecting a release client to localhost.
        #[cfg(not(debug_assertions))]
        let raw_base = COMPILED_API_BASE_URL.unwrap_or("").to_string();
        Self::with_credentials(&raw_base, Arc::new(OsCredentialStore))
    }
}

impl DesktopAuthState {
    fn with_credentials(raw_base: &str, credentials: Arc<dyn CredentialStore>) -> Self {
        let client = Client::builder()
            // Authentication must go directly to the configured API and must
            // never inherit the proxy being configured by the desktop app.
            .no_proxy()
            // Do not allow a redirect to turn one of the three fixed auth
            // endpoints into a request to an unrelated location.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| DesktopAuthError::new("http_client", "无法初始化桌面端登录网络组件"));

        Self {
            client,
            api_base_url: normalize_api_base_url(raw_base),
            session: Arc::new(Mutex::new(SessionState::default())),
            operation: Arc::new(tokio::sync::Mutex::new(())),
            credentials,
        }
    }

    /// Whether Rust currently holds a server-validated desktop-user session.
    ///
    /// Other IPC modules can use this as a fast local guard.  A fresh process
    /// remains unauthenticated until `desktop_restore_session` has validated
    /// the keyring token through `/api/user/auth/me`.
    pub fn is_authenticated(&self) -> bool {
        self.session
            .lock()
            .map(|state| session_is_current(&state))
            .unwrap_or(false)
    }

    async fn product_info(&self) -> AuthResult<ProductInfo> {
        let response = self
            .client()?
            .get(self.endpoint(PRODUCT_NAME_PATH)?)
            .send()
            .await
            .map_err(network_error)?;
        let wire: ProductNameResponse =
            decode_success_json(response, "产品名称响应格式错误").await?;
        let api_base = self.api_base_url.as_ref().map_err(Clone::clone)?;
        Ok(product_info_from_wire(api_base, wire))
    }

    async fn product_name(&self) -> AuthResult<String> {
        Ok(self.product_info().await?.product_name)
    }

    /// Return the Rust-owned desktop identity without exposing the bearer token.
    pub(crate) fn current_identity(&self) -> AuthResult<(i64, Option<String>, u64)> {
        let state = self.session_guard()?;
        let user = state.user.as_ref().filter(|user| {
            user.role == "client"
                && user.status == "active"
                && state.token.is_some()
                && state
                    .expires_at_unix
                    .is_some_and(|expiry| expiry > now_unix())
        });
        user.map(|user| (user.id, state.profile_key.clone(), state.generation))
            .ok_or_else(|| DesktopAuthError::new("unauthenticated", "桌面登录已失效，请重新登录"))
    }

    /// Revalidate one exact local session and configuration lease. The lease
    /// endpoint applies full server-side user authentication, so one request
    /// detects token expiry/account revocation and administrator config changes.
    pub(crate) async fn validate_desktop_lease(
        &self,
        user_id: i64,
        generation: u64,
        expected_lease: &str,
    ) -> AuthResult<bool> {
        let _operation = self.operation.lock().await;
        let token = {
            let state = self.session_guard()?;
            let same_session = state.generation == generation
                && state.user.as_ref().map(|user| user.id) == Some(user_id);
            if !same_session {
                return Err(DesktopAuthError::new(
                    "session_changed",
                    "登录用户已发生变化",
                ));
            }
            if !session_is_current(&state) {
                drop(state);
                self.clear_local_session()?;
                return Err(DesktopAuthError::new(
                    "unauthenticated",
                    "桌面登录已失效，请重新登录",
                ));
            }
            state
                .token
                .clone()
                .expect("current session must contain a token")
        };

        let response = self
            .client()?
            .get(self.endpoint(DESKTOP_CONFIG_LEASE_PATH)?)
            .bearer_auth(token)
            .send()
            .await
            .map_err(network_error)?;

        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            self.clear_local_session()?;
            return Err(DesktopAuthError::new(
                "unauthenticated",
                "账号已失效、停用或登录已过期",
            ));
        }

        let lease: DesktopLeaseResponse =
            decode_success_json(response, "桌面配置租约响应格式错误").await?;
        if lease.lease.len() != 64 || !lease.lease.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(DesktopAuthError::invalid_response(
                "桌面配置租约响应格式错误",
            ));
        }

        let state = self.session_guard()?;
        if state.generation != generation
            || state.user.as_ref().map(|current| current.id) != Some(user_id)
        {
            return Err(DesktopAuthError::new(
                "session_changed",
                "登录用户已发生变化",
            ));
        }
        Ok(lease.lease == expected_lease)
    }

    /// Fetch the one fixed authenticated configuration endpoint. The generic
    /// result remains inside Rust; callers must deserialize into an explicit
    /// allowlisted shape before anything crosses IPC.
    pub(crate) async fn fetch_desktop_config<T: DeserializeOwned>(&self) -> AuthResult<T> {
        let _operation = self.operation.lock().await;
        let token = self
            .in_memory_token()?
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                DesktopAuthError::new("unauthenticated", "桌面登录已失效，请重新登录")
            })?;

        let response = self
            .client()?
            .get(self.endpoint(DESKTOP_CONFIG_PATH)?)
            .bearer_auth(token)
            .send()
            .await
            .map_err(network_error)?;

        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            self.clear_local_session()?;
            return Err(DesktopAuthError::new(
                "unauthenticated",
                "桌面登录已失效，请重新登录",
            ));
        }

        decode_success_json(response, "桌面配置响应格式错误").await
    }

    /// Bind a validated profile key to the same user that initiated the sync.
    /// The identity check prevents a late response from an old login from
    /// contaminating a newly logged-in user's browser profile.
    pub(crate) fn set_profile_key(&self, user_id: i64, profile_key: String) -> AuthResult<()> {
        let mut state = self.session_guard()?;
        if state.user.as_ref().map(|user| user.id) != Some(user_id) || state.token.is_none() {
            return Err(DesktopAuthError::new(
                "session_changed",
                "登录用户已发生变化，请重新同步桌面配置",
            ));
        }
        state.profile_key = Some(profile_key);
        Ok(())
    }

    /// Log in through the desktop-user endpoint.  Neither the password nor the
    /// bearer token is present in the returned value.
    async fn login(&self, username: String, password: String) -> AuthResult<DesktopUser> {
        let _operation = self.operation.lock().await;
        let username = username.trim();
        if username.is_empty() {
            return Err(DesktopAuthError::new("invalid_input", "请输入用户账号"));
        }
        // Do not trim passwords: leading/trailing whitespace may be valid.
        if password.is_empty() {
            return Err(DesktopAuthError::new("invalid_input", "请输入登录密码"));
        }

        let response = self
            .client()?
            .post(self.endpoint(LOGIN_PATH)?)
            .json(&LoginRequest {
                username,
                password: &password,
            })
            .send()
            .await
            .map_err(network_error)?;
        let wire: LoginResponse = decode_success_json(response, "登录响应格式错误").await?;
        let (token, user) = wire.into_session()?;

        // Persist only after the server response has been verified as a client
        // account.  Password is dropped with this stack frame and is never
        // written to either state or the keyring.
        self.persist_session(token, user.clone())?;
        Ok(user)
    }

    /// Restore a saved session by validating the token against `/me`.
    async fn restore_session(&self) -> AuthResult<Option<DesktopUser>> {
        let _operation = self.operation.lock().await;
        let token = match self.in_memory_token()? {
            Some(token) => token,
            None => match self.credentials.load_token().map_err(keyring_error)? {
                Some(token) if !token.trim().is_empty() => token,
                Some(_) => {
                    self.clear_local_session()?;
                    return Ok(None);
                }
                None => {
                    self.clear_memory()?;
                    return Ok(None);
                }
            },
        };

        let response = self
            .client()?
            .get(self.endpoint(ME_PATH)?)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(network_error)?;

        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            self.clear_local_session()?;
            return Ok(None);
        }

        let user: DesktopUser = decode_success_json(response, "用户信息响应格式错误").await?;
        let user = match user.ensure_desktop_role() {
            Ok(user) => user,
            Err(error) => {
                self.clear_local_session()?;
                return Err(error);
            }
        };
        self.set_memory(token, user.clone())?;
        Ok(Some(user))
    }

    /// Revoke the server token and always remove the local copy.  A network
    /// failure is reported after local cleanup, so retrying logout never leaves
    /// JavaScript with access to a credential.
    async fn logout(&self) -> AuthResult<()> {
        let _operation = self.operation.lock().await;
        let token = match self.in_memory_token()? {
            Some(token) => Some(token),
            None => self.credentials.load_token().map_err(keyring_error)?,
        };

        self.clear_memory()?;
        let delete_result = self.credentials.delete_token().map_err(keyring_error);

        let remote_result = if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
            self.revoke_token(token).await
        } else {
            Ok(())
        };

        // Keyring deletion is the critical local guarantee.  Prefer that error
        // if both local cleanup and the best-effort server request failed.
        delete_result?;
        remote_result
    }

    async fn change_password(
        &self,
        current_password: String,
        new_password: String,
    ) -> AuthResult<()> {
        let _operation = self.operation.lock().await;
        if current_password.is_empty() {
            return Err(DesktopAuthError::new("invalid_input", "请输入当前密码"));
        }
        if new_password.chars().count() < 6 || new_password.chars().count() > 256 {
            return Err(DesktopAuthError::new(
                "invalid_input",
                "新密码长度必须为 6～256 个字符",
            ));
        }
        if current_password == new_password {
            return Err(DesktopAuthError::new(
                "invalid_input",
                "新密码不能与当前密码相同",
            ));
        }
        let token = self
            .in_memory_token()?
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                DesktopAuthError::new("unauthenticated", "桌面登录已失效，请重新登录")
            })?;
        let response = self
            .client()?
            .post(self.endpoint(CHANGE_PASSWORD_PATH)?)
            .bearer_auth(token)
            .json(&ChangePasswordRequest {
                current_password: &current_password,
                new_password: &new_password,
            })
            .send()
            .await
            .map_err(network_error)?;
        ensure_success(response).await?;

        // The server bumps token_version after a password change. Remove the
        // now-invalid local token and require a fresh login with the new secret.
        self.clear_local_session()
    }

    async fn revoke_token(&self, token: String) -> AuthResult<()> {
        let response = self
            .client()?
            .post(self.endpoint(LOGOUT_PATH)?)
            .bearer_auth(token)
            .send()
            .await
            .map_err(network_error)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            Ok(())
        } else {
            ensure_success(response).await
        }
    }

    fn client(&self) -> AuthResult<&Client> {
        self.client.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn api_base_url(&self) -> Result<&str, DesktopAuthError> {
        self.api_base_url.as_deref().map_err(Clone::clone)
    }

    fn endpoint(&self, path: &str) -> AuthResult<String> {
        let base = self.api_base_url.as_ref().map_err(Clone::clone)?;
        debug_assert!(matches!(
            path,
            LOGIN_PATH
                | ME_PATH
                | LOGOUT_PATH
                | CHANGE_PASSWORD_PATH
                | DESKTOP_CONFIG_PATH
                | DESKTOP_CONFIG_LEASE_PATH
                | PRODUCT_NAME_PATH
        ));
        Ok(format!("{base}{path}"))
    }

    fn session_guard(&self) -> AuthResult<MutexGuard<'_, SessionState>> {
        self.session
            .lock()
            .map_err(|_| DesktopAuthError::state_unavailable())
    }

    fn in_memory_token(&self) -> AuthResult<Option<String>> {
        Ok(self.session_guard()?.token.clone())
    }

    fn persist_session(&self, token: String, user: DesktopUser) -> AuthResult<()> {
        self.credentials.save_token(&token).map_err(keyring_error)?;
        if let Err(error) = self.set_memory(token, user) {
            let _ = self.credentials.delete_token();
            return Err(error);
        }
        Ok(())
    }

    fn set_memory(&self, token: String, user: DesktopUser) -> AuthResult<()> {
        let expires_at_unix = token_expiry(&token)?;
        let mut state = self.session_guard()?;
        state.generation = state.generation.wrapping_add(1).max(1);
        state.token = Some(token);
        state.user = Some(user);
        state.expires_at_unix = Some(expires_at_unix);
        state.profile_key = None;
        Ok(())
    }

    fn clear_memory(&self) -> AuthResult<()> {
        let mut state = self.session_guard()?;
        state.generation = state.generation.wrapping_add(1).max(1);
        state.token = None;
        state.user = None;
        state.expires_at_unix = None;
        state.profile_key = None;
        Ok(())
    }

    fn clear_local_session(&self) -> AuthResult<()> {
        self.clear_memory()?;
        self.credentials.delete_token().map_err(keyring_error)
    }
}

#[derive(Deserialize)]
struct TokenMetadata {
    typ: String,
    exp: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn token_expiry(token: &str) -> AuthResult<u64> {
    let (payload, signature) = token
        .split_once('.')
        .ok_or_else(|| DesktopAuthError::invalid_response("账号服务返回了无效的访问令牌"))?;
    if payload.is_empty() || signature.is_empty() || payload.len() > 16 * 1024 {
        return Err(DesktopAuthError::invalid_response(
            "账号服务返回了无效的访问令牌",
        ));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| DesktopAuthError::invalid_response("账号服务返回了无效的访问令牌"))?;
    let metadata: TokenMetadata = serde_json::from_slice(&bytes)
        .map_err(|_| DesktopAuthError::invalid_response("账号服务返回了无效的访问令牌"))?;
    if metadata.typ != "user" || metadata.exp <= now_unix() {
        return Err(DesktopAuthError::new(
            "unauthenticated",
            "桌面登录已失效，请重新登录",
        ));
    }
    Ok(metadata.exp)
}

fn session_is_current(state: &SessionState) -> bool {
    state.token.as_ref().is_some_and(|token| !token.is_empty())
        && state
            .user
            .as_ref()
            .is_some_and(|user| user.role == "client" && user.status == "active")
        && state
            .expires_at_unix
            .is_some_and(|expiry| expiry > now_unix())
}

#[tauri::command]
pub async fn desktop_product_name<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, DesktopAuthState>,
) -> AuthResult<String> {
    state.product_name().await
}

#[tauri::command]
pub async fn desktop_product_info<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, DesktopAuthState>,
) -> AuthResult<ProductInfo> {
    state.product_info().await
}

#[tauri::command]
pub async fn desktop_login<R: Runtime>(
    app: AppHandle<R>,
    proxy_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, DesktopAuthState>,
    username: String,
    password: String,
) -> AuthResult<DesktopUser> {
    // An account switch must never leave the previous user's browser active
    // while the new login request is in flight.
    let _lifecycle_guard = proxy_state.lock_desktop_sync().await;
    app.state::<BrowserSessionManager>().close_all();
    proxy_state.teardown();
    state.login(username, password).await
}

async fn perform_desktop_restore(
    proxy_state: &AppState,
    state: &DesktopAuthState,
    close_browser: impl FnOnce(),
) -> AuthResult<Option<DesktopUser>> {
    let _lifecycle_guard = proxy_state.lock_desktop_sync().await;
    close_browser();
    proxy_state.teardown();
    state.restore_session().await
}

#[tauri::command]
pub async fn desktop_restore_session<R: Runtime>(
    app: AppHandle<R>,
    proxy_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, DesktopAuthState>,
) -> AuthResult<Option<DesktopUser>> {
    // Restore is a lifecycle transition too: a repeated IPC call must not
    // change auth generation underneath a published adapter or browser.
    perform_desktop_restore(proxy_state.inner(), state.inner(), || {
        app.state::<BrowserSessionManager>().close_all();
    })
    .await
}

async fn perform_desktop_logout(
    proxy_state: &AppState,
    state: &DesktopAuthState,
    close_browser: impl FnOnce(),
) -> AuthResult<()> {
    let _lifecycle_guard = proxy_state.lock_desktop_sync().await;
    close_browser();
    proxy_state.teardown();
    state.logout().await
}

#[tauri::command]
pub async fn desktop_logout<R: Runtime>(
    app: AppHandle<R>,
    proxy_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, DesktopAuthState>,
) -> AuthResult<()> {
    // Serialize local route revocation with `sync_desktop_config`. Once any
    // in-flight sync finishes, close the browser and adapter before the
    // best-effort server revoke, and prevent a late adapter publication.
    perform_desktop_logout(proxy_state.inner(), state.inner(), || {
        app.state::<BrowserSessionManager>().close_all();
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn desktop_change_password<R: Runtime>(
    app: AppHandle<R>,
    proxy_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, DesktopAuthState>,
    current_password: String,
    new_password: String,
) -> AuthResult<()> {
    let _lifecycle_guard = proxy_state.lock_desktop_sync().await;
    let result = state.change_password(current_password, new_password).await;
    if result.is_ok() {
        app.state::<BrowserSessionManager>().close_all();
        proxy_state.teardown();
    }
    result
}

fn normalize_api_base_url(raw: &str) -> AuthResult<String> {
    normalize_api_base_url_with_options(raw, COMPILED_ALLOW_INSECURE_API == Some("1"))
}

fn normalize_api_base_url_with_options(raw: &str, allow_insecure_api: bool) -> AuthResult<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(DesktopAuthError::new(
            "api_base_url",
            format!("{API_BASE_URL_ENV} 不能为空"),
        ));
    }
    let parsed = Url::parse(raw).map_err(|_| {
        DesktopAuthError::new("api_base_url", format!("{API_BASE_URL_ENV} 不是有效的网址"))
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(DesktopAuthError::new(
            "api_base_url",
            format!("{API_BASE_URL_ENV} 必须是无账号、查询参数和片段的 http(s) 地址"),
        ));
    }
    if parsed.scheme() == "http"
        && !allow_insecure_api
        && !parsed.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    {
        return Err(DesktopAuthError::new(
            "api_base_url",
            format!("{API_BASE_URL_ENV} 的非本机地址必须使用 HTTPS"),
        ));
    }
    Ok(raw.trim_end_matches('/').to_string())
}

fn network_error(_error: reqwest::Error) -> DesktopAuthError {
    // reqwest errors can contain request URLs.  Do not forward arbitrary debug
    // text across IPC; a stable message is both safer and more useful to users.
    DesktopAuthError::new("network", "无法连接账号服务，请检查网络或联系管理员")
}

fn keyring_error(_error: String) -> DesktopAuthError {
    DesktopAuthError::new("keyring", "无法访问系统安全存储，请解锁系统钥匙串后重试")
}

/// The envelope every Vestus JSON endpoint answers with.
///
/// `data` stays generic so each caller still deserializes straight into its own
/// wire type; `requestId` is deliberately not read -- the desktop app has no use
/// for it, and ignoring an unknown field is serde's default anyway.
#[derive(Deserialize)]
struct ApiEnvelope<T> {
    code: i64,
    data: T,
}

async fn decode_success_json<T: DeserializeOwned>(
    response: reqwest::Response,
    malformed_message: &str,
) -> AuthResult<T> {
    let status = response.status();
    let body = response.bytes().await.map_err(network_error)?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(DesktopAuthError::invalid_response("账号服务响应过大"));
    }
    if !status.is_success() {
        return Err(http_error(status, &body));
    }
    let envelope: ApiEnvelope<T> = serde_json::from_slice(&body)
        .map_err(|_| DesktopAuthError::invalid_response(malformed_message))?;
    if envelope.code != API_CODE_OK {
        // The contract pairs every failure code with a non-2xx status, so this
        // is a server that disagrees with itself -- or a proxy answering for it.
        return Err(http_error(status, &body));
    }
    Ok(envelope.data)
}

async fn ensure_success(response: reqwest::Response) -> AuthResult<()> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.bytes().await.map_err(network_error)?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(DesktopAuthError::invalid_response("账号服务响应过大"));
    }
    Err(http_error(status, &body))
}

fn http_error(status: StatusCode, body: &[u8]) -> DesktopAuthError {
    let (code, fallback) = match status {
        StatusCode::UNAUTHORIZED => ("invalid_credentials", "账号或密码错误"),
        StatusCode::FORBIDDEN => ("account_unavailable", "账号已被禁用、锁定或过期"),
        StatusCode::TOO_MANY_REQUESTS => ("rate_limited", "尝试次数过多，请稍后再试"),
        status if status.is_server_error() => ("server", "账号服务暂时不可用，请稍后再试"),
        _ => ("request_failed", "账号服务拒绝了本次请求"),
    };
    let message = api_error_message(body).unwrap_or_else(|| fallback.to_string());
    DesktopAuthError::new(code, message)
}

/// The envelope's human-readable `msg`, when the body is one.
///
/// A 422 no longer needs the per-field walk the old FastAPI `detail` array
/// required: the server already joins those into a single `msg`.
fn api_error_message(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let message = value.get("msg")?.as_str()?.trim();
    if message.is_empty() {
        None
    } else {
        // Bound untrusted server text before it crosses IPC.
        Some(message.chars().take(300).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemoryCredentialStore {
        token: Mutex<Option<String>>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn load_token(&self) -> Result<Option<String>, String> {
            Ok(self.token.lock().unwrap().clone())
        }

        fn save_token(&self, token: &str) -> Result<(), String> {
            *self.token.lock().unwrap() = Some(token.to_string());
            Ok(())
        }

        fn delete_token(&self) -> Result<(), String> {
            *self.token.lock().unwrap() = None;
            Ok(())
        }
    }

    fn client_user() -> DesktopUser {
        DesktopUser {
            id: 7,
            username: "desktop-user".into(),
            name: "Desktop User".into(),
            role: "client".into(),
            company: Some("Test Co".into()),
            status: "active".into(),
            expires_at: Some("2099-12-31".into()),
            must_change_password: false,
        }
    }

    fn valid_test_token() -> String {
        let payload = serde_json::json!({
            "typ": "user",
            "exp": now_unix() + 3600,
        });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        format!("{encoded}.test-signature")
    }

    fn test_token(typ: &str, exp: u64) -> String {
        let payload = serde_json::json!({"typ": typ, "exp": exp});
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        format!("{encoded}.test-signature")
    }

    #[test]
    fn parses_backend_response_with_both_token_spellings() {
        let body = serde_json::json!({
            "access_token": "server-secret-token",
            "accessToken": "server-secret-token",
            "user": client_user(),
        });
        let response: LoginResponse = serde_json::from_value(body).unwrap();
        let (token, user) = response.into_session().unwrap();
        assert_eq!(token, "server-secret-token");
        assert_eq!(user.role, "client");
    }

    #[test]
    fn rejects_non_client_role_before_persisting() {
        let mut user = client_user();
        user.role = "admin".into();
        let response = LoginResponse {
            access_token: Some("server-secret-token".into()),
            access_token_camel: None,
            user,
        };
        let error = response.into_session().unwrap_err();
        assert_eq!(error.code, "wrong_role");
    }

    #[test]
    fn serialized_desktop_user_has_no_credential_fields() {
        let value = serde_json::to_value(client_user()).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 8);
        for allowed in [
            "id",
            "username",
            "name",
            "role",
            "company",
            "status",
            "expiresAt",
            "mustChangePassword",
        ] {
            assert!(object.contains_key(allowed));
        }
    }

    #[test]
    fn persists_only_token_and_keeps_user_in_rust_state() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let state = DesktopAuthState::with_credentials(DEFAULT_API_BASE_URL, credentials.clone());
        let token = valid_test_token();
        state.persist_session(token.clone(), client_user()).unwrap();

        assert_eq!(
            credentials.load_token().unwrap().as_deref(),
            Some(token.as_str())
        );
        let state = state.session_guard().unwrap();
        assert_eq!(state.token.as_deref(), Some(token.as_str()));
        assert_eq!(state.user.as_ref().map(|user| user.id), Some(7));
        assert_eq!(state.profile_key, None);
        assert!(state
            .expires_at_unix
            .is_some_and(|expiry| expiry > now_unix()));
    }

    #[test]
    fn profile_key_is_bound_to_the_authenticated_user() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let state = DesktopAuthState::with_credentials(DEFAULT_API_BASE_URL, credentials);
        state
            .persist_session(valid_test_token(), client_user())
            .unwrap();

        state.set_profile_key(7, "profile-a".into()).unwrap();
        assert_eq!(
            state.current_identity().unwrap(),
            (7, Some("profile-a".into()), 1)
        );
        assert_eq!(
            state
                .set_profile_key(8, "profile-b".into())
                .unwrap_err()
                .code,
            "session_changed"
        );
    }

    #[test]
    fn authentication_guard_requires_validated_client_session() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let state = DesktopAuthState::with_credentials(DEFAULT_API_BASE_URL, credentials);
        assert!(!state.is_authenticated());

        state
            .persist_session(valid_test_token(), client_user())
            .unwrap();
        assert!(state.is_authenticated());

        state.clear_memory().unwrap();
        assert!(!state.is_authenticated());
    }

    #[test]
    fn rejects_expired_or_non_user_token_metadata() {
        assert!(token_expiry(&test_token("user", now_unix().saturating_sub(1))).is_err());
        assert!(token_expiry(&test_token("admin", now_unix() + 3600)).is_err());
        assert!(token_expiry("not-a-token").is_err());
    }

    #[tokio::test]
    async fn restore_without_token_needs_no_network_or_real_keyring() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let state = DesktopAuthState::with_credentials(DEFAULT_API_BASE_URL, credentials);
        assert_eq!(state.restore_session().await.unwrap(), None);
    }

    #[tokio::test]
    async fn logout_without_token_needs_no_network_or_real_keyring() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let state = DesktopAuthState::with_credentials(DEFAULT_API_BASE_URL, credentials.clone());
        state.logout().await.unwrap();
        assert_eq!(credentials.load_token().unwrap(), None);
    }

    #[tokio::test]
    async fn desktop_logout_waits_for_sync_then_wins_final_state() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let proxy_state = AppState::default();
        let auth_state = DesktopAuthState::with_credentials(
            DEFAULT_API_BASE_URL,
            Arc::new(MemoryCredentialStore::default()),
        );
        let sync_guard = proxy_state.lock_desktop_sync().await;
        assert!(proxy_state.begin_testing());

        let browser_closed = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let proxy_state = proxy_state.clone();
            let auth_state = auth_state.clone();
            let browser_closed = Arc::clone(&browser_closed);
            async move {
                perform_desktop_logout(&proxy_state, &auth_state, || {
                    browser_closed.store(true, Ordering::SeqCst);
                })
                .await
            }
        });

        tokio::task::yield_now().await;
        assert!(!browser_closed.load(Ordering::SeqCst));
        assert_eq!(proxy_state.snapshot().phase, crate::state::Phase::Testing);

        // Model an in-flight sync reaching its publication boundary. Logout
        // must acquire the gate afterwards and leave the final state torn down.
        drop(sync_guard);
        task.await.unwrap().unwrap();

        assert!(browser_closed.load(Ordering::SeqCst));
        assert_eq!(
            proxy_state.snapshot().phase,
            crate::state::Phase::Unconfigured
        );
        assert!(!proxy_state.can_open_browser());
    }

    #[tokio::test]
    async fn desktop_restore_waits_for_lifecycle_gate_and_tears_down_runtime() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let proxy_state = AppState::default();
        let auth_state = DesktopAuthState::with_credentials(
            DEFAULT_API_BASE_URL,
            Arc::new(MemoryCredentialStore::default()),
        );
        let sync_guard = proxy_state.lock_desktop_sync().await;
        assert!(proxy_state.begin_testing());

        let browser_closed = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let proxy_state = proxy_state.clone();
            let auth_state = auth_state.clone();
            let browser_closed = Arc::clone(&browser_closed);
            async move {
                perform_desktop_restore(&proxy_state, &auth_state, || {
                    browser_closed.store(true, Ordering::SeqCst);
                })
                .await
            }
        });

        tokio::task::yield_now().await;
        assert!(!browser_closed.load(Ordering::SeqCst));
        drop(sync_guard);
        assert_eq!(task.await.unwrap().unwrap(), None);
        assert!(browser_closed.load(Ordering::SeqCst));
        assert_eq!(
            proxy_state.snapshot().phase,
            crate::state::Phase::Unconfigured
        );
    }

    #[test]
    fn normalizes_base_url_and_builds_only_fixed_auth_paths() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let state = DesktopAuthState::with_credentials(" https://api.example.test/ ", credentials);
        assert_eq!(
            state.endpoint(LOGIN_PATH).unwrap(),
            "https://api.example.test/api/user/auth/login"
        );
        assert_eq!(
            state.endpoint(ME_PATH).unwrap(),
            "https://api.example.test/api/user/auth/me"
        );
        assert_eq!(
            state.endpoint(LOGOUT_PATH).unwrap(),
            "https://api.example.test/api/user/auth/logout"
        );
        assert_eq!(
            state.endpoint(CHANGE_PASSWORD_PATH).unwrap(),
            "https://api.example.test/api/user/auth/change-password"
        );
        assert_eq!(
            state.endpoint(DESKTOP_CONFIG_PATH).unwrap(),
            "https://api.example.test/api/user/desktop-config"
        );
        assert_eq!(
            state.endpoint(DESKTOP_CONFIG_LEASE_PATH).unwrap(),
            "https://api.example.test/api/user/desktop-config/lease"
        );
        assert_eq!(
            state.endpoint(PRODUCT_NAME_PATH).unwrap(),
            "https://api.example.test/api/product"
        );
    }

    #[test]
    fn rejects_api_base_url_with_credentials_or_query() {
        assert!(normalize_api_base_url("https://user:pass@example.test").is_err());
        assert!(normalize_api_base_url("https://example.test?redirect=evil").is_err());
        assert!(normalize_api_base_url("file:///tmp/api").is_err());
        assert!(normalize_api_base_url("http://api.example.test").is_err());
        assert!(normalize_api_base_url("http://127.0.0.1:8000").is_ok());
        assert!(normalize_api_base_url("http://[::1]:8000").is_ok());
    }

    #[test]
    fn remote_http_api_requires_the_explicit_compile_time_option() {
        assert!(
            normalize_api_base_url_with_options("http://api.example.test/vestus", false,).is_err()
        );
        assert_eq!(
            normalize_api_base_url_with_options("http://api.example.test/vestus", true).unwrap(),
            "http://api.example.test/vestus"
        );
    }

    #[test]
    fn resolves_uploaded_asset_under_the_compiled_api_base_path() {
        assert_eq!(
            resolve_uploaded_asset_url(
                "https://api.example.test/vestus",
                "/uploads/2026/08/0123456789abcdef0123456789abcdef.png",
            ),
            Some(
                "https://api.example.test/vestus/uploads/2026/08/0123456789abcdef0123456789abcdef.png".to_string()
            )
        );
        assert_eq!(
            resolve_uploaded_asset_url(
                "https://api.example.test/vestus",
                "https://api.example.test/vestus/uploads/2026/08/fedcba9876543210fedcba9876543210.png",
            ),
            Some(
                "https://api.example.test/vestus/uploads/2026/08/fedcba9876543210fedcba9876543210.png"
                    .to_string()
            )
        );
    }

    #[test]
    fn rejects_non_upload_or_untrusted_asset_urls() {
        for value in [
            "data:image/png;base64,AAAA",
            "https://cdn.example.test/uploads/logo.png",
            "https://api.example.test.evil.test/vestus/uploads/logo.png",
            "/uploads/../api/user/auth/me",
            "/uploads/%2e%2e/api/user/auth/me",
            "/uploads/logo.png?cache=1",
            "/uploads/logo.png#fragment",
            "//api.example.test/uploads/logo.png",
            "/uploads\\logo.png",
            "/uploads/2026/00/0123456789abcdef0123456789abcdef.png",
            "/uploads/2026/13/0123456789abcdef0123456789abcdef.png",
            "/uploads/26/08/0123456789abcdef0123456789abcdef.png",
            "/uploads/2026/08/0123456789abcdef.png",
            "/uploads/2026/08/0123456789ABCDEF0123456789ABCDEF.png",
            "/uploads/2026/08/0123456789abcdef0123456789abcdef.Png",
            "/uploads/2026/08/0123456789abcdef0123456789abcdef.abcdefghijklmnopq",
            "/uploads/2026/08/0123456789abcdef0123456789abcdef.png/extra",
        ] {
            assert_eq!(
                resolve_uploaded_asset_url("https://api.example.test/vestus", value),
                None,
                "应当拒绝不可信资源地址：{value}"
            );
        }
    }

    #[test]
    fn product_branding_exposes_only_api_scoped_uploaded_logo() {
        let product = product_info_from_wire(
            "https://api.example.test",
            ProductNameResponse {
                product_name: " 企业客户端 ".into(),
                logo_url: Some("/uploads/2026/08/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp".into()),
            },
        );
        assert_eq!(product.product_name, "企业客户端");
        assert_eq!(
            product.logo_url.as_deref(),
            Some("https://api.example.test/uploads/2026/08/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp")
        );

        let rejected = product_info_from_wire(
            "https://api.example.test",
            ProductNameResponse {
                product_name: "Vestus".into(),
                logo_url: Some("data:image/png;base64,AAAA".into()),
            },
        );
        assert_eq!(rejected.logo_url, None);
    }

    #[test]
    fn extracts_bounded_envelope_error_message() {
        let msg = "x".repeat(400);
        let body = serde_json::to_vec(&serde_json::json!({
            "code": 40000,
            "msg": msg,
            "data": null,
            "requestId": "",
        }))
        .unwrap();
        let extracted = api_error_message(&body).unwrap();
        assert_eq!(extracted.chars().count(), 300);
    }

    #[test]
    fn falls_back_to_the_status_message_when_the_body_is_not_an_envelope() {
        // A reverse proxy answering for a stopped backend does not know the
        // envelope; the user still has to see something actionable.
        let error = http_error(StatusCode::BAD_GATEWAY, b"<html>502 Bad Gateway</html>");
        assert_eq!(error.code, "server");
        assert_eq!(error.message, "账号服务暂时不可用，请稍后再试");
    }
}
