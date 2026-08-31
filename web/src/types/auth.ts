export type AdminRole = "admin" | "super_admin";
export type AccountStatus = "active" | "disabled" | "locked";

export interface AdminProfile {
  id: number;
  username: string;
  name: string;
  role: AdminRole;
  status: AccountStatus;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoginResponse {
  /** 桌面端存这个；控制台同时拿到会话 Cookie，所以两条路都能鉴权。 */
  accessToken?: string;
  admin?: AdminProfile;
  expiresAt?: string;
}
