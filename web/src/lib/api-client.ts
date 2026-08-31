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
import { API_CODE_OK, ApiCollection, ApiEnvelope, SystemHealth } from "@/types/api";

const REQUEST_FAILED_MESSAGE = "请求失败，请稍后重试";

export class ApiError extends Error {
  status: number;
  /** 后端的业务码；用它区分同一状态码下的不同失败原因。 */
  code: number;
  requestId: string;
  data: unknown;

  constructor(message: string, status: number, code: number, requestId: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.data = data;
  }
}

let inMemoryToken: string | null = null;

export const setAuthToken = (token: string | null) => {
  inMemoryToken = token;
};

async function send(
  path: string,
  options: RequestInit,
): Promise<{ response: Response; body: unknown }> {
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

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "include",
  });

  let body: unknown = null;
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }

  return { response, body };
}

function toApiError(response: Response, body: unknown): ApiError {
  // 反向代理返回的 502 HTML、或走不到应用的 404，都没有信封可读。
  const envelope = (body ?? {}) as Partial<ApiEnvelope>;
  const message =
    typeof envelope.msg === "string" && envelope.msg ? envelope.msg : REQUEST_FAILED_MESSAGE;
  // 与后端 `ApiCode.for_status` 同一条规则：状态码 × 100。
  const code = typeof envelope.code === "number" ? envelope.code : response.status * 100;
  return new ApiError(message, response.status, code, envelope.requestId ?? "", envelope.data);
}

/**
 * 调用一个走信封的端点，只把 `data` 交给调用方。
 *
 * 缺少信封或 `code !== 0` 都算失败，即使 HTTP 状态是 200——中间层塞回来的
 * 错误页正是这个形状，放过去只会让错误在更远处以更难懂的方式炸开。
 */
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { response, body } = await send(path, options);
  const envelope = (body ?? {}) as Partial<ApiEnvelope<T>>;
  if (!response.ok || envelope.code !== API_CODE_OK) {
    throw toApiError(response, body);
  }
  return envelope.data as T;
}

/** 调用不走信封的探针端点，目前只有 `/healthz`。 */
async function requestUnenveloped<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { response, body } = await send(path, options);
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return body as T;
}

export const api = {
  // Auth
  async login(payload: { username: string; password: string }): Promise<LoginResponse> {
    const grant = await request<LoginResponse>("/api/admin/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (grant.accessToken) {
      setAuthToken(grant.accessToken);
    }
    return grant;
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
    const { items } = await request<ApiCollection<DesktopUser>>(`/api/admin/users${query}`);
    return items;
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

  async enableUser(id: number): Promise<DesktopUser> {
    return request<DesktopUser>(`/api/admin/users/${id}/enable`, {
      method: "POST",
    });
  },

  async disableUser(id: number): Promise<DesktopUser> {
    return request<DesktopUser>(`/api/admin/users/${id}/disable`, {
      method: "POST",
    });
  },

  // 这些写操作没有可回报的内容：`code === 0` 就是全部答案。
  async resetUserPassword(id: number, password: string): Promise<void> {
    await request<null>(`/api/admin/users/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },

  async deleteUser(id: number): Promise<void> {
    await request<null>(`/api/admin/users/${id}`, {
      method: "DELETE",
    });
  },

  async getUserStats(): Promise<UserStats> {
    return request<UserStats>("/api/admin/stats");
  },

  // Proxies
  async listProxies(): Promise<ProxyItem[]> {
    const { items } = await request<ApiCollection<ProxyItem>>("/api/admin/proxies");
    return items;
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

  async deleteProxy(id: number): Promise<void> {
    await request<null>(`/api/admin/proxies/${id}`, {
      method: "DELETE",
    });
  },

  // Platforms
  async listPlatforms(): Promise<PlatformItem[]> {
    const { items } = await request<ApiCollection<PlatformItem>>("/api/admin/platforms");
    return items;
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

  async deletePlatform(id: number): Promise<void> {
    await request<null>(`/api/admin/platforms/${id}`, {
      method: "DELETE",
    });
  },

  // Admins
  async listAdmins(search?: string, status?: string): Promise<AdminUser[]> {
    const params = new URLSearchParams();
    if (search) params.append("search", search);
    if (status) params.append("status", status);
    const query = params.toString() ? `?${params.toString()}` : "";
    const { items } = await request<ApiCollection<AdminUser>>(`/api/admin/admins${query}`);
    return items;
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

  async enableAdmin(id: number): Promise<AdminUser> {
    return request<AdminUser>(`/api/admin/admins/${id}/enable`, {
      method: "POST",
    });
  },

  async disableAdmin(id: number): Promise<AdminUser> {
    return request<AdminUser>(`/api/admin/admins/${id}/disable`, {
      method: "POST",
    });
  },

  async resetAdminPassword(id: number, password: string): Promise<void> {
    await request<null>(`/api/admin/admins/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },

  async deleteAdmin(id: number): Promise<void> {
    await request<null>(`/api/admin/admins/${id}`, {
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
    return requestUnenveloped<SystemHealth>("/healthz");
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
