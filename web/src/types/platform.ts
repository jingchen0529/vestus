import { ProxyItem } from "./proxy";

export interface PlatformItem {
  id: number;
  name: string;
  url: string;
  iconUrl?: string;
  sortOrder: number;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
}

export interface CreatePlatformPayload {
  name: string;
  url: string;
  iconUrl?: string;
  sortOrder: number;
  status: "active" | "disabled";
}

export interface UpdatePlatformPayload {
  name?: string;
  url?: string;
  iconUrl?: string;
  sortOrder?: number;
  status?: "active" | "disabled";
}

export interface DesktopConfigResponse {
  proxy?: ProxyItem | null;
  proxyId?: number | null;
  platforms?: PlatformItem[];
  platformIds?: number[];
}

export interface SaveDesktopConfigPayload {
  proxyId: number | null;
  platformIds: number[];
}
