import type {
  ManagedAuthMode,
  ManagedIdentityCheckMetadata,
  ManagedIdentityCheckResponse,
  ManagedRecoveryState,
  ManagedSessionStatus,
} from "@/types/managed-platform";
import { isManagedRecovering, managedRecoveryLabel } from "@/lib/managed-recovery";

interface ManagedIdentitySource extends ManagedRecoveryState, ManagedIdentityCheckMetadata {
  authMode?: ManagedAuthMode | null;
  sessionStatus?: ManagedSessionStatus;
  identityCheckedAt?: string | null;
}

export interface ManagedIdentityDisplay {
  label: string;
  variant: "outline" | "warning" | "destructive";
  recovering: boolean;
  detail: string | null;
  checkedAt: string | null;
  verifiedAt: string | null;
}

export function managedIdentityDisplay(account: ManagedIdentitySource): ManagedIdentityDisplay {
  const display: ManagedIdentityDisplay = {
    label: "会话正常",
    variant: "outline",
    recovering: false,
    detail: account.lastIdentityCheckDetail || null,
    checkedAt: account.lastIdentityCheckAt || null,
    verifiedAt: account.identityCheckedAt || null,
  };

  if (isManagedRecovering(account)) {
    return {
      ...display,
      label: managedRecoveryLabel(account),
      variant: "warning",
      recovering: true,
      detail: account.lastError || display.detail,
    };
  }
  if (account.recoveryStatus === "failed") {
    return {
      ...display,
      label: "自动恢复失败",
      variant: "destructive",
      detail: account.lastError || display.detail,
    };
  }
  if (account.sessionStatus === "expired") {
    const guidance = account.authMode === "cookie"
      ? "请替换 Cookie 后重试"
      : account.authMode === "server_login"
        ? account.autoRelogin
          ? "请等待自动恢复，若持续失败请检查账号密码"
          : "请检查账号密码并重新登录"
        : "请重新登录后重试";
    return {
      ...display,
      label: "会话已失效",
      variant: "destructive",
      detail: [account.lastError || display.detail, guidance].filter(Boolean).join("；"),
    };
  }
  if (account.lastIdentityCheckState === "unavailable") {
    return { ...display, label: "校验失败／待确认", variant: "warning" };
  }
  return display;
}

interface ManagedIdentityCheckToast {
  level: "success" | "warning" | "error";
  message: string;
  description?: string;
}

export function managedIdentityCheckToast(result: ManagedIdentityCheckResponse): ManagedIdentityCheckToast {
  if (result.state === "invalid") {
    const display = managedIdentityDisplay({ ...result.account, sessionStatus: "expired" });
    return {
      level: "error",
      message: display.recovering
        ? `登录态已失效，${display.label}`
        : "登录态已失效，会话已标记过期",
      description: result.detail || display.detail || display.label,
    };
  }
  if (result.account.sessionStatus === "expired") {
    return {
      level: "warning",
      message: "身份已确认，会话仍失效",
      description: result.detail || managedIdentityDisplay(result.account).detail || undefined,
    };
  }
  return {
    level: "success",
    message: `登录态有效：${result.account.remoteDisplayName || "身份已刷新"}`,
  };
}

export function managedIdentityCheckErrorToast(error: unknown): ManagedIdentityCheckToast {
  const unavailable = error instanceof Error && "status" in error && error.status === 503;
  return {
    level: unavailable ? "warning" : "error",
    message: unavailable ? "校验失败／待确认" : "检查登录态失败",
    description: error instanceof Error ? error.message : "请稍后重试",
  };
}
