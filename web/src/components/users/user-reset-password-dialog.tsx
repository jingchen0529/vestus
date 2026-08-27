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
import { DesktopUser } from "@/types/user";
import { generateRandomPassword } from "@/lib/utils";
import { Sparkles, Copy, Check, KeyRound, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface UserResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: DesktopUser | null;
  onSubmitReset: (id: number, password: string) => Promise<void>;
}

export function UserResetPasswordDialog({
  open,
  onOpenChange,
  user,
  onSubmitReset,
}: UserResetPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword(generateRandomPassword(12));
    }
  }, [open]);

  if (!user) return null;

  const handleGeneratePassword = () => {
    const pwd = generateRandomPassword(12);
    setPassword(pwd);
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
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 mb-1">
            <KeyRound className="h-5 w-5" />
            <DialogTitle>重置用户密码</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            为桌面端账号 <span className="font-semibold text-foreground">{user.username}</span>（{user.name}）设定新的登录密码。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>重置密码后，系统将自动失效该用户所有已登录客户端会话。</span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="reset-pwd" required>
                新密码
              </Label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleGeneratePassword}
                  className="text-[11px] text-primary hover:underline flex items-center gap-1"
                >
                  <Sparkles className="h-3 w-3" />
                  <span>换一个</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyPassword}
                  className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                  <span>{copied ? "已复制" : "复制"}</span>
                </button>
              </div>
            </div>
            <Input
              id="reset-pwd"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
              disabled={loading}
            />
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              取消
            </Button>
            <Button type="submit" variant="warning" loading={loading}>
              确认重置
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
