import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DesktopUser } from "@/types/user";
import { generateRandomPassword } from "@/lib/utils";
import { Sparkles, Copy, Check, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface UserResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: DesktopUser | null;
  onSubmitReset: (id: number, password: string) => Promise<void>;
}

const ICON_BTN =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

export function UserResetPasswordDialog({
  open,
  onOpenChange,
  user,
  onSubmitReset,
}: UserResetPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(true);

  useEffect(() => {
    if (open) {
      setPassword(generateRandomPassword(12));
    }
  }, [open]);

  if (!user) return null;

  const handleGeneratePassword = () => {
    const pwd = generateRandomPassword(12);
    setPassword(pwd);
    setShowPassword(true);
  };

  const handleCopyPassword = () => {
    navigator.clipboard.writeText(password);
    setCopied(true);
    toast.success("密码已复制到剪贴板");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || password.length < 6) {
      toast.error("新密码至少需要 6 个字符");
      return;
    }

    setLoading(true);
    try {
      await onSubmitReset(user.id, password);
      toast.success(`用户 ${user.username} 的密码已重置成功`, {
        description: "该用户的已有在线 Token 已被强制吊销",
      });
      onOpenChange(false);
    } catch (err: any) {
      toast.error("重置失败", {
        description: err.message || "请稍后重试",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <div className="shrink-0 border-b border-border/60 px-6 pb-4 pr-14 pt-5">
          <DialogTitle className="text-[17px] font-semibold leading-tight tracking-[-0.01em]">
            重置用户密码
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-xs leading-relaxed">
            为桌面端账号{" "}
            <span className="font-medium text-foreground">{user.username}</span>
            <span className="text-muted-foreground">（{user.name}）</span>{" "}
            设定新的登录密码
          </DialogDescription>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {/* 影响范围前置说明：这是一个会踢掉在线会话的操作 */}
            <div className="flex items-start gap-2.5 rounded-[10px] border border-warning/25 bg-warning/[0.07] px-3 py-2.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <p className="text-[11px] leading-relaxed text-warning/90">
                保存后，该用户所有已登录的客户端会话会立即失效，需要用新密码重新登录。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-pwd" required>
                新密码
              </Label>
              <div className="relative">
                <Input
                  id="reset-pwd"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-10 pr-[108px] font-mono text-[13px]"
                  minLength={6}
                  required
                  disabled={loading}
                />
                <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                  <button
                    type="button"
                    title={showPassword ? "隐藏密码" : "显示密码"}
                    onClick={() => setShowPassword((v) => !v)}
                    className={ICON_BTN}
                    disabled={loading}
                  >
                    {showPassword ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    title="换一个随机密码"
                    onClick={handleGeneratePassword}
                    className={ICON_BTN}
                    disabled={loading}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="复制密码"
                    onClick={handleCopyPassword}
                    className={ICON_BTN}
                    disabled={loading}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                至少 6 位。复制后请通过可靠渠道转交用户。
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3.5">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              取消
            </Button>
            <Button type="submit" loading={loading}>
              确认重置
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
