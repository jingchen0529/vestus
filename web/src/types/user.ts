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
  /** 单独指定的 VPN 节点；null 表示跟随默认代理。 */
  proxyId?: number | null;
  /** 绑定的管理员；null 表示仅超级管理员可见。 */
  boundAdminId?: number | null;
  /** 由服务端富化的展示名，可能缺失（如引用已被删除）。 */
  proxyName?: string | null;
  /** 所指派的节点当前是否启用；false 表示该指派已失效，用户实际走默认节点。 */
  proxyActive?: boolean | null;
  boundAdminName?: string | null;
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
  proxyId?: number | null;
  boundAdminId?: number | null;
  remark?: string | null;
}

export interface UpdateUserPayload {
  name?: string;
  company?: string | null;
  phone?: string | null;
  expiresAt?: string | null;
  maxSessions?: number;
  proxyId?: number | null;
  boundAdminId?: number | null;
  remark?: string | null;
  status?: DesktopUser["status"];
}
