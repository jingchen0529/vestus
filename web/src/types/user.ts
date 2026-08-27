export interface DesktopUser {
  id: number;
  username: string;
  name: string;
  company?: string | null;
  phone?: string | null;
  status: "active" | "disabled" | "locked";
  expiresAt?: string | null;
  maxSessions: number;
  tokenVersion?: number;
  failedLoginCount?: number;
  lockedUntil?: string | null;
  mustChangePassword?: boolean;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  createdBy?: number | null;
  remark?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserStats {
  total: number;
  active: number;
  disabled: number;
  locked: number;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  name: string;
  company?: string | null;
  phone?: string | null;
  expiresAt?: string | null;
  maxSessions: number;
  remark?: string | null;
}

export interface UpdateUserPayload {
  name?: string;
  company?: string | null;
  phone?: string | null;
  expiresAt?: string | null;
  maxSessions?: number;
  remark?: string | null;
  status?: DesktopUser["status"];
}
