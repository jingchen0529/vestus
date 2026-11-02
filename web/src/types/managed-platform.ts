export type ManagedAuthMode = "cookie" | "server_login" | "official_sso";

/** The two credential sources exposed by the per-user Ark configuration UI. */
export type UserManagedAuthMode = "cookie" | "server_login";

export type ManagedAccountStatus = "active" | "expired" | "revoked" | "invalid";

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

export interface ManagedPlatformAccount {
  id: number;
  platformId: number;
  name: string;
  authMode: ManagedAuthMode;
  allowedHosts: string[];
  credentialVersion: number;
  expiresAt?: string | null;
  status: ManagedAccountStatus;
  lastVerifiedAt?: string | null;
  createdBy?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateManagedPlatformAccountPayload {
  platformId: number;
  name: string;
  authMode: ManagedAuthMode;
  username?: string;
  password?: string;
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

export interface ManagedAccountVerification {
  account: ManagedPlatformAccount;
  verification?: "verified";
}

export interface UserManagedPlatformAccount {
  platformId: number;
  platformName?: string | null;
  authMode: UserManagedAuthMode;
  username?: string | null;
  password?: string | null;
  cookieBundle?: ManagedCookieInput[] | null;
  expiresAt?: string | null;
  allowedHosts?: string[];
  status?: ManagedAccountStatus;
  credentialVersion?: number;
}

export interface UserManagedPlatformAccountPayload {
  authMode: UserManagedAuthMode;
  username?: string;
  password?: string;
  cookieBundle?: ManagedCookieInput[];
}

