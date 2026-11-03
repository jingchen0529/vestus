import type {
  CreateUserManagedAccountPayload,
  ManagedBindingItem,
  ManagedPlatformAccount,
} from "@/types/managed-platform";

// The per-user create/bind endpoints currently target Ark (platform 1).
export const MANAGED_BINDING_PLATFORM_ID = 1;
export type BindingSource = "create" | "existing";

export function bindableAccounts(
  accounts: ManagedPlatformAccount[],
  bindings: ManagedBindingItem[],
  userId: number,
  now = Date.now(),
): ManagedPlatformAccount[] {
  const boundIds = new Set(
    bindings
      .filter((binding) => binding.userId === userId && binding.status === "active")
      .map((binding) => binding.managedAccountId),
  );
  return accounts.filter((account) => {
    const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : null;
    return (
      account.platformId === MANAGED_BINDING_PLATFORM_ID &&
      account.status === "active" &&
      account.sessionStatus !== "expired" &&
      (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > now)) &&
      !boundIds.has(account.id)
    );
  });
}

interface SubmitBindingOptions {
  source: BindingSource;
  userId: number;
  accountId?: number;
  candidates: ManagedPlatformAccount[];
  buildPayload: () => CreateUserManagedAccountPayload;
  onCreateAccount?: (userId: number, payload: CreateUserManagedAccountPayload) => Promise<void>;
  onBindAccount?: (userId: number, accountId: number) => Promise<void>;
}

export async function submitNewBinding({
  source,
  userId,
  accountId,
  candidates,
  buildPayload,
  onCreateAccount,
  onBindAccount,
}: SubmitBindingOptions): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("请选择有效的桌面用户");
  }
  if (source === "existing") {
    if (!onBindAccount) throw new Error("当前不支持绑定已有账号");
    if (!candidates.some((account) => account.id === accountId)) {
      throw new Error("请选择可用且尚未绑定的方舟账号");
    }
    await onBindAccount(userId, accountId!);
    return;
  }
  if (!onCreateAccount) throw new Error("当前不支持创建托管账号");
  await onCreateAccount(userId, buildPayload());
}
