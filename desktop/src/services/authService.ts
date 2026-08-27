// Desktop-user authentication is owned by the Rust/Tauri layer.
// The Web admin uses web/admin.html and never imports this service.

export type UserRole = "client";

export interface ProductBranding {
  productName: string;
  logoUrl?: string;
}

export interface UserAccount {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  company?: string;
  status: "active" | "disabled" | "expired";
  expiresAt: string;
  mustChangePassword: boolean;
}

const LEGACY_STORAGE_KEYS = [
  "vestus_users_list_v1",
  "vestus_current_session_v1",
  "vestus_audit_logs_v1",
  "vestus_access_token",
  "vestus_auth_role",
  "vestus_auth_expires_at",
];

function clearLegacyStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key);
    for (const key of LEGACY_STORAGE_KEYS) window.sessionStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
}

function commandErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message || "").trim();
    if (message) return message;
  }
  return fallback;
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("桌面端用户登录仅可在 Vestus 客户端中使用");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(command, args);
}

function normaliseDesktopUser(raw: any): UserAccount {
  if (raw?.role !== "client") {
    throw new Error("账号类型不属于桌面端用户");
  }
  const rawStatus = String(raw?.status ?? "active");
  const status: UserAccount["status"] =
    rawStatus === "disabled" || rawStatus === "expired" || rawStatus === "locked"
      ? rawStatus === "locked"
        ? "disabled"
        : rawStatus
      : "active";
  return {
    id: String(raw?.id ?? ""),
    username: String(raw?.username ?? ""),
    name: String(raw?.name ?? raw?.username ?? ""),
    role: "client",
    company: raw?.company ?? undefined,
    status,
    expiresAt: String(raw?.expiresAt ?? raw?.expires_at ?? "2099-12-31"),
    mustChangePassword: Boolean(
      raw?.mustChangePassword ?? raw?.must_change_password ?? false
    ),
  };
}

function accountExpiryTimestamp(expiresAt: string): number | null {
  if (!expiresAt) return null;
  const value = expiresAt.length === 10 ? `${expiresAt}T23:59:59.999Z` : expiresAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

class AuthService {
  private currentUser: UserAccount | null = null;
  private restorePromise: Promise<UserAccount | null> | null = null;

  constructor() {
    clearLegacyStorage();
  }

  public getCurrentUser(): UserAccount | null {
    return this.currentUser;
  }

  public async getProductName(): Promise<string> {
    if (!isTauriRuntime()) return "Vestus";
    try {
      const value = String(await invokeDesktop<string>("desktop_product_name")).trim();
      return value || "Vestus";
    } catch {
      return "Vestus";
    }
  }

  public async getProductInfo(): Promise<ProductBranding> {
    if (!isTauriRuntime()) return { productName: "Vestus" };
    try {
      const info = await invokeDesktop<ProductBranding>("desktop_product_info");
      if (info && info.productName) {
        return {
          productName: info.productName.trim() || "Vestus",
          logoUrl: info.logoUrl?.trim() || undefined,
        };
      }
      const name = await this.getProductName();
      return { productName: name };
    } catch {
      const name = await this.getProductName();
      return { productName: name };
    }
  }

  public isAuthenticated(): boolean {
    if (!this.currentUser || this.currentUser.role !== "client") return false;
    if (this.currentUser.status !== "active") return false;
    if (this.currentUser.expiresAt) {
      const accountExpiry = accountExpiryTimestamp(this.currentUser.expiresAt);
      if (accountExpiry !== null && accountExpiry < Date.now()) return false;
    }
    return true;
  }

  /** Restore a short-lived session by validating it against the server. */
  public async restoreSession(): Promise<UserAccount | null> {
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = this.restoreSessionInternal().finally(() => {
      this.restorePromise = null;
    });
    return this.restorePromise;
  }

  private async restoreSessionInternal(): Promise<UserAccount | null> {
    if (!isTauriRuntime()) {
      this.currentUser = null;
      return null;
    }
    try {
      const raw = await invokeDesktop<any | null>("desktop_restore_session");
      const user = raw ? normaliseDesktopUser(raw) : null;
      this.currentUser = user;
      return user;
    } catch {
      this.currentUser = null;
      return null;
    }
  }

  public async login(username: string, password: string): Promise<UserAccount> {
    const cleanUser = username.trim();
    if (!cleanUser) throw new Error("请输入账号");
    if (!password) throw new Error("请输入密码");
    try {
      const raw = await invokeDesktop<any>("desktop_login", {
        username: cleanUser,
        password,
      });
      const user = normaliseDesktopUser(raw);
      this.currentUser = user;
      return user;
    } catch (error) {
      this.currentUser = null;
      throw new Error(commandErrorMessage(error, "登录失败，请检查账号密码"));
    }
  }

  public async logout(): Promise<void> {
    this.currentUser = null;
    try {
      if (isTauriRuntime()) await invokeDesktop<void>("desktop_logout");
    } catch (error) {
      throw new Error(commandErrorMessage(error, "退出登录未完全成功"));
    } finally {
      this.currentUser = null;
    }
  }

  public async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      await invokeDesktop<void>("desktop_change_password", {
        currentPassword,
        newPassword,
      });
      this.currentUser = null;
    } catch (error) {
      throw new Error(commandErrorMessage(error, "修改密码失败"));
    }
  }
}

export const authService = new AuthService();
