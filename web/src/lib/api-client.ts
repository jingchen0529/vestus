import {
  AdminProfile,
  LoginResponse,
} from "@/types/auth";
import {
  DesktopUser,
  UserStats,
  CreateUserPayload,
  UpdateUserPayload,
} from "@/types/user";
import {
  ProxyItem,
  CreateProxyPayload,
  UpdateProxyPayload,
} from "@/types/proxy";
import {
  PlatformItem,
  CreatePlatformPayload,
  UpdatePlatformPayload,
} from "@/types/platform";
import {
  AdminUser,
  CreateAdminPayload,
  UpdateAdminPayload,
} from "@/types/admin";
import { UserLogResponse, UserLogItem } from "@/types/log";
import { SystemHealth } from "@/types/api";

class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

function parseErrorMessage(data: any): string {
  if (!data) return "请求失败，请稍后重试";
  const detail = data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((d: any) => d?.msg || String(d)).join("；");
  }
  if (detail && typeof detail === "object") {
    return detail.message || JSON.stringify(detail);
  }
  if (data.message) return data.message;
  return "请求异常";
}

let inMemoryToken: string | null = null;

export const setAuthToken = (token: string | null) => {
  inMemoryToken = token;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (inMemoryToken) {
    headers["Authorization"] = `Bearer ${inMemoryToken}`;
  }

  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: "include",
  });

  let data: any = {};
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    throw new ApiError(parseErrorMessage(data), res.status, data);
  }

  return data as T;
}

export const api = {
  // Auth
  async login(payload: { username: string; password: string }): Promise<LoginResponse> {
    const res = await request<LoginResponse>("/api/admin/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.token) {
      setAuthToken(res.token);
    }
    return res;
  },

  async getMe(): Promise<AdminProfile> {
    return request<AdminProfile>("/api/admin/auth/me");
  },

  async logout(): Promise<void> {
    try {
      await request("/api/admin/auth/logout", { method: "POST" });
    } finally {
      setAuthToken(null);
    }
  },

  // Users
  async listUsers(search?: string, status?: string): Promise<DesktopUser[]> {
    const params = new URLSearchParams();
    if (search) params.append("search", search);
    if (status) params.append("status", status);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await request<DesktopUser[] | { items: DesktopUser[] }>(`/api/admin/users${query}`);
    return Array.isArray(res) ? res : res.items || [];
  },

  async getUser(id: number): Promise<DesktopUser> {
    return request<DesktopUser>(`/api/admin/users/${id}`);
  },

  async createUser(payload: CreateUserPayload): Promise<DesktopUser> {
    return request<DesktopUser>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateUser(id: number, payload: UpdateUserPayload): Promise<DesktopUser> {
    return request<DesktopUser>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async enableUser(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/users/${id}/enable`, {
      method: "POST",
    });
  },

  async disableUser(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/users/${id}/disable`, {
      method: "POST",
    });
  },

  async resetUserPassword(id: number, password: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/users/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },

  async deleteUser(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/users/${id}`, {
      method: "DELETE",
    });
  },

  async getUserStats(): Promise<UserStats> {
    return request<UserStats>("/api/admin/stats");
  },

  // Proxies
  async listProxies(): Promise<ProxyItem[]> {
    const res = await request<ProxyItem[] | { items: ProxyItem[] }>("/api/admin/proxies");
    return Array.isArray(res) ? res : res.items || [];
  },

  async createProxy(payload: CreateProxyPayload): Promise<ProxyItem> {
    return request<ProxyItem>("/api/admin/proxies", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateProxy(id: number, payload: UpdateProxyPayload): Promise<ProxyItem> {
    return request<ProxyItem>(`/api/admin/proxies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deleteProxy(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/proxies/${id}`, {
      method: "DELETE",
    });
  },

  // Platforms
  async listPlatforms(): Promise<PlatformItem[]> {
    const res = await request<PlatformItem[] | { items: PlatformItem[] }>("/api/admin/platforms");
    return Array.isArray(res) ? res : res.items || [];
  },

  async createPlatform(payload: CreatePlatformPayload): Promise<PlatformItem> {
    return request<PlatformItem>("/api/admin/platforms", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updatePlatform(id: number, payload: UpdatePlatformPayload): Promise<PlatformItem> {
    return request<PlatformItem>(`/api/admin/platforms/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deletePlatform(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/platforms/${id}`, {
      method: "DELETE",
    });
  },

  // Admins
  async listAdmins(search?: string, status?: string): Promise<AdminUser[]> {
    const params = new URLSearchParams();
    if (search) params.append("search", search);
    if (status) params.append("status", status);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await request<AdminUser[] | { items: AdminUser[] }>(`/api/admin/admins${query}`);
    return Array.isArray(res) ? res : res.items || [];
  },

  async getAdmin(id: number): Promise<AdminUser> {
    return request<AdminUser>(`/api/admin/admins/${id}`);
  },

  async createAdmin(payload: CreateAdminPayload): Promise<AdminUser> {
    return request<AdminUser>("/api/admin/admins", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateAdmin(id: number, payload: UpdateAdminPayload): Promise<AdminUser> {
    return request<AdminUser>(`/api/admin/admins/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async enableAdmin(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/admins/${id}/enable`, {
      method: "POST",
    });
  },

  async disableAdmin(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/admins/${id}/disable`, {
      method: "POST",
    });
  },

  async resetAdminPassword(id: number, password: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/admins/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },

  async deleteAdmin(id: number): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/admin/admins/${id}`, {
      method: "DELETE",
    });
  },

  // Logs
  async listLogs(params: {
    page?: number;
    pageSize?: number;
    status?: string;
    action?: string;
  } = {}): Promise<UserLogResponse> {
    const searchParams = new URLSearchParams();
    searchParams.append("page", String(params.page || 1));
    searchParams.append("pageSize", String(params.pageSize || 100));
    if (params.status) searchParams.append("status", params.status);
    if (params.action) searchParams.append("action", params.action);

    return request<UserLogResponse>(`/api/admin/user-logs?${searchParams.toString()}`);
  },

  async getLog(id: number): Promise<UserLogItem> {
    return request<UserLogItem>(`/api/admin/user-logs/${id}`);
  },

  // System Health
  async getHealth(): Promise<SystemHealth> {
    return request<SystemHealth>("/healthz");
  },

  async getProduct(): Promise<Record<string, any>> {
    return request<Record<string, any>>("/api/product");
  },

  // System Settings / Branding
  async getSettings(): Promise<SystemSettingsData> {
    return request<SystemSettingsData>("/api/admin/settings");
  },

  async updateSettings(data: Partial<SystemSettingsData>): Promise<SystemSettingsData> {
    return request<SystemSettingsData>("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  async uploadFile(file: File): Promise<{
    url: string;
    path: string;
    name: string;
    contentType: string;
    size: number;
  }> {
    const formData = new FormData();
    formData.append("file", file);
    return request("/api/admin/uploads", {
      method: "POST",
      body: formData,
    });
  },
};

export interface SystemSettingsData {
  productName: string;
  logoUrl?: string;
  adminTitle?: string;
  adminLogoUrl?: string;
  adminThemeColor?: string;
}
