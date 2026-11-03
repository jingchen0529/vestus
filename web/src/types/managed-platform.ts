export type ManagedAuthMode = "cookie" | "server_login" | "official_sso";

/** The two credential sources exposed by the per-user Ark configuration UI. */
export type UserManagedAuthMode = "cookie" | "server_login";

export type ManagedAccountStatus = "active" | "expired" | "revoked" | "invalid";

/** 上游登录会话（cookie）是否仍可用；expired 表示客户端上报了平台侧退出登录。 */
export type ManagedSessionStatus = "valid" | "expired";

/**
 * Cookie attributes accepted by the administrator API.
 *
 * The per-user response contains plaintext credentials because that endpoint
 * is restricted to super administrators; the general account list type below
 * remains secret-free.
 */
export interface ManagedCookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expiresAt?: string | null;
  partitionKey?: unknown;
  priority?: string;
  sourceScheme?: string;
}

export type ManagedRecoveryStatus = "idle" | "pending" | "running" | "retry_wait" | "failed";

export interface ManagedRecoveryState {
  autoRelogin?: boolean;
  recoveryStatus?: ManagedRecoveryStatus;
  recoveryAttempts?: number;
  nextRecoveryAt?: string | null;
  lastRecoveredAt?: string | null;
  lastError?: string | null;
}

export interface ManagedPlatformAccount extends ManagedRecoveryState {
  id: number;
  platformId: number;
  name: string;
  authMode: ManagedAuthMode;
  allowedHosts: string[];
  credentialVersion: number;
  expiresAt?: string | null;
  status: ManagedAccountStatus;
  sessionStatus?: ManagedSessionStatus;
  lastError?: string | null;
  lastVerifiedAt?: string | null;
  createdBy?: number | null;
  createdAt?: string;
  updatedAt?: string;
  remoteAccountId?: string | null;
  remoteDisplayName?: string | null;
  identityCheckedAt?: string | null;
}

export interface CreateManagedPlatformAccountPayload {
  platformId: number;
  name: string;
  authMode: ManagedAuthMode;
  username?: string;
  password?: string;
  autoRelogin?: boolean;
  cookieBundle?: ManagedCookieInput[];
  allowedHosts?: string[];
  expiresAt?: string | null;
  status?: ManagedAccountStatus;
}

export interface UpdateManagedPlatformAccountPayload {
  name?: string;
  authMode?: ManagedAuthMode;
  username?: string;
  password?: string;
  autoRelogin?: boolean;
  cookieBundle?: ManagedCookieInput[];
  allowedHosts?: string[];
  expiresAt?: string | null;
  status?: ManagedAccountStatus;
}

export interface ManagedPlatformBinding {
  id: number;
  userId: number;
  platformId: number;
  managedAccountId: number;
  status: "active" | "revoked";
}

export interface UserManagedAccountBinding extends ManagedRecoveryState {
  id: number;
  userId: number;
  platformId: number;
  platformName?: string | null;
  managedAccountId: number;
  name: string;
  accountName?: string;
  alias?: string | null;
  authMode?: ManagedAuthMode | null;
  status: ManagedAccountStatus | "active";
  sessionStatus?: ManagedSessionStatus;
  expiresAt?: string | null;
  credentialVersion?: number;
  remoteAccountId?: string | null;
  remoteDisplayName?: string | null;
  identityCheckedAt?: string | null;
  lastVerifiedAt?: string | null;
}

export interface ManagedAccountVerification {
  account: ManagedPlatformAccount;
  verification?: "verified";
}

export interface UserManagedPlatformAccount extends ManagedRecoveryState {
  id?: number;
  name?: string;
  platformId: number;
  platformName?: string | null;
  authMode: UserManagedAuthMode;
  username?: string | null;
  password?: string | null;
  hasPassword?: boolean;
  sessionStatus?: ManagedSessionStatus;
  cookieBundle?: ManagedCookieInput[] | null;
  expiresAt?: string | null;
  allowedHosts?: string[];
  status?: ManagedAccountStatus;
  credentialVersion?: number;
}

/** 「绑定托管」总览页的一行：用户 × 托管账号绑定及其会话状态。 */
export interface ManagedBindingItem extends ManagedRecoveryState {
  bindingId: number;
  userId: number;
  username: string;
  userName?: string | null;
  userStatus?: string | null;
  platformId: number;
  platformName: string;
  managedAccountId: number;
  name: string;
  authMode: ManagedAuthMode;
  status: "active" | "revoked";
  accountStatus: ManagedAccountStatus;
  sessionStatus: ManagedSessionStatus;
  lastError?: string | null;
  credentialVersion: number;
  expiresAt?: string | null;
  lastVerifiedAt?: string | null;
  remoteDisplayName?: string | null;
  identityCheckedAt?: string | null;
}

export interface ManagedBindingsResponse {
  items: ManagedBindingItem[];
  total: number;
  expiredCount: number;
}

/** 「检查登录态」接口返回：探测结论 + 刷新后的账号信息。 */
export interface ManagedIdentityCheckResponse {
  state: "verified" | "invalid";
  detail: string;
  account: ManagedPlatformAccount;
}

export interface UserManagedPlatformAccountPayload {
  authMode: UserManagedAuthMode;
  username?: string;
  password?: string;
  autoRelogin?: boolean;
  cookieBundle?: ManagedCookieInput[];
}

export interface CreateUserManagedAccountPayload extends UserManagedPlatformAccountPayload {
  name?: string;
}

export interface UpdateUserManagedAccountPayload {
  name?: string;
  authMode?: UserManagedAuthMode;
  username?: string;
  password?: string;
  autoRelogin?: boolean;
  cookieBundle?: ManagedCookieInput[];
}

