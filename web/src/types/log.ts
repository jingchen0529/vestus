export type AuditLogCategory =
  | "admin_login"
  | "admin_operation"
  | "desktop_login"
  | "desktop_operation"
  | "system"
  | "unknown";

export type AuditLogCategoryFilter = AuditLogCategory | "ALL";

export const AUDIT_LOG_CATEGORY_LABELS: Record<AuditLogCategory, string> = {
  admin_login: "管理端登录",
  admin_operation: "管理端操作",
  desktop_login: "桌面端登录",
  desktop_operation: "桌面端操作",
  system: "系统操作",
  unknown: "来源不明",
};

export interface UserLogItem {
  id: number;
  requestId?: string | null;
  actorType: "admin" | "user" | "system";
  actorId?: number | null;
  actorUsername?: string | null;
  actorRole?: string | null;
  action: string;
  // 新接口提供中文标签；可选以兼容缺少这些字段的历史响应。
  actionLabel?: string;
  category?: AuditLogCategory;
  categoryLabel?: string;
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

export function getLogPresentation(log: UserLogItem) {
  const category = log.category ?? "unknown";
  const anonymousLogin = log.actorType === "system" && !log.actorId && log.action === "LOGIN";
  const actorTypes: Record<string, string> = { admin: "管理员", user: "桌面用户", system: "系统" };
  const actorRoles: Record<string, string> = { super_admin: "超级管理员", admin: "普通管理员", user: "桌面用户" };

  return {
    actionLabel: log.actionLabel?.trim() || "其他操作",
    category,
    categoryLabel: log.categoryLabel?.trim() || AUDIT_LOG_CATEGORY_LABELS[category] || "来源不明",
    actorName: log.actorUsername || (log.actorType === "system" && !anonymousLogin ? "系统" : "未识别账号"),
    actorTypeLabel: anonymousLogin ? "未认证主体" : actorTypes[log.actorType] || "未知主体",
    actorRoleLabel: log.actorRole ? actorRoles[log.actorRole] || "未知角色" : "",
  };
}

export interface UserLogResponse {
  items: UserLogItem[];
  total: number;
  page: number;
  pageSize: number;
}
