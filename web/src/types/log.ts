export interface UserLogItem {
  id: number;
  requestId?: string | null;
  actorType: "admin" | "user" | "system";
  actorId?: number | null;
  actorUsername?: string | null;
  actorRole?: string | null;
  action: string;
  summary: string;
  targetType?: string | null;
  targetId?: number | null;
  targetName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  status: "SUCCESS" | "FAILED";
  details?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface UserLogResponse {
  items: UserLogItem[];
  total: number;
  page: number;
  pageSize: number;
}
