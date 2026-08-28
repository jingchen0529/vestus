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
