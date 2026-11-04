import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdminUser } from "@/types/admin";
import { generateRandomPassword } from "@/lib/utils";
import { Sparkles, Copy, Check, AlertTriangle, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

interface AdminResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  admin: AdminUser | null;
  onSubmitReset: (id: number, password: string) => Promise<void>;
}

export function AdminResetPasswordDialog({
  open,
  onOpenChange,
  admin,
  onSubmitReset,
}: AdminResetPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(true);

  useEffect(() => {
    if (open) {
      setPassword(generateRandomPassword(12));
    }
  }, [open]);

  if (!admin) return null;

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
      await onSubmitReset(admin.id, password);
      toast.success(`管理员 ${admin.username} 的密码已重置成功`, {
        description: "该管理员的所有历史在线 Token 已强制失效",
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
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>重置管理员密码</DialogTitle>
          <DialogDescription className="text-xs">
            为系统管理员 <span className="font-semibold text-foreground">{admin.username}</span>（{admin.name}）重设登录密码。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2.5 rounded-[10px] border border-warning/25 bg-warning/[0.07] px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="text-[11px] leading-relaxed text-warning/90">
            保存后，该管理员当前的登录会话会立即失效，需要用新密码重新登录。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="admin-reset-pwd" required>
              新密码
            </Label>
            <div className="relative">
              <Input
                id="admin-reset-pwd"
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
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  disabled={loading}
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  title="换一个随机密码"
                  onClick={handleGeneratePassword}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  disabled={loading}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="复制密码"
                  onClick={handleCopyPassword}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  disabled={loading}
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              至少 6 位。复制后请通过可靠渠道转交该管理员。
            </p>
          </div>

          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
