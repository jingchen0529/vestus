import type { ManagedRecoveryState } from "@/types/managed-platform";

export function isManagedRecovering(account: ManagedRecoveryState): boolean {
  return Boolean(account.autoRelogin && ["pending", "running", "retry_wait"].includes(account.recoveryStatus || ""));
}

export function managedRecoveryLabel(account: ManagedRecoveryState): string {
  switch (account.recoveryStatus) {
    case "pending": return "等待自动登录";
    case "running": return "自动登录中";
    case "retry_wait": return `等待自动重试（已尝试 ${account.recoveryAttempts || 0} 次）`;
    case "failed": return "自动恢复失败";
    default: return "自动维护登录态";
  }
}
