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
  token?: string;
  admin?: AdminProfile;
  expiresIn?: number;
}
