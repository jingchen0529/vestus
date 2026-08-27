import { AccountStatus, AdminRole } from "./auth";

export interface AdminUser {
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

export interface CreateAdminPayload {
  username: string;
  password: string;
  name: string;
  role: AdminRole;
}

export interface UpdateAdminPayload {
  name?: string;
  role?: AdminRole;
}
