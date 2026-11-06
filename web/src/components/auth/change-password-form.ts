import type { ChangeAdminPasswordPayload } from "@/types/auth";

export interface ChangePasswordFields extends ChangeAdminPasswordPayload {
  confirmPassword: string;
}

export function validateChangePassword({ currentPassword, newPassword, confirmPassword }: ChangePasswordFields): string | null {
  if (!currentPassword) return "请输入当前密码";
  if (newPassword.length < 6 || newPassword.length > 256) return "新密码长度须为 6–256 位";
  if (newPassword === currentPassword) return "新密码不能与当前密码相同";
  if (confirmPassword !== newPassword) return "两次输入的新密码不一致";
  return null;
}
