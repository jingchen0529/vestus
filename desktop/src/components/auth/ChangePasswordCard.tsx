import React, { useState } from "react";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { authService } from "@/services/authService";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

interface ChangePasswordCardProps {
  username: string;
  onLogout: () => Promise<void> | void;
  onPasswordChanged: () => void;
}

export const ChangePasswordCard: React.FC<ChangePasswordCardProps> = ({
  username,
  onLogout,
  onPasswordChanged,
}) => {
  const { success, error } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (newPassword.length < 6) {
      setMessage("新密码至少需要 6 个字符");
      return;
    }
    if (newPassword !== confirmation) {
      setMessage("两次输入的新密码不一致");
      return;
    }
    if (currentPassword === newPassword) {
      setMessage("新密码不能与当前密码相同");
      return;
    }
    setSubmitting(true);
    try {
      await authService.changePassword(currentPassword, newPassword);
      success("密码已更新", "请使用新密码重新登录");
      onPasswordChanged();
    } catch (reason: any) {
      const text = reason?.message || "修改密码失败";
      setMessage(text);
      error("修改密码失败", text);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-background text-foreground p-4 flex items-center justify-center relative transition-colors">
      {/* Draggable window header region */}
      <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-10 z-10 select-none cursor-default" />
      <div className="absolute top-4 right-4 z-20">
        <ThemeToggle variant="compact" />
      </div>

      <Card className="w-full max-w-[350px] border-border bg-card/95 shadow-xl backdrop-blur-xl">
        <CardHeader className="pb-3 pt-5 text-center flex flex-col items-center">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <CardTitle className="text-sm font-semibold text-foreground">请修改初始密码</CardTitle>
          <CardDescription className="text-[11px] text-muted-foreground mt-1">
            账号 {username} 的密码由管理员重置，修改后即可登录。
          </CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className="space-y-3 pb-5">
            {message && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-600 dark:text-rose-300">
                {message}
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">当前密码</label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder="请输入当前密码"
                icon={<KeyRound className="h-3.5 w-3.5" />}
                className="h-8.5 text-xs"
                disabled={submitting}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">新密码</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="新密码（至少 6 个字符）"
                icon={<KeyRound className="h-3.5 w-3.5" />}
                className="h-8.5 text-xs"
                disabled={submitting}
                minLength={6}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">确认新密码</label>
              <Input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="再次输入新密码"
                icon={<KeyRound className="h-3.5 w-3.5" />}
                className="h-8.5 text-xs"
                disabled={submitting}
                minLength={6}
                required
              />
            </div>
            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white font-medium shadow-md shadow-amber-500/20 h-8.5 text-xs mt-1"
              disabled={submitting}
            >
              {submitting ? "正在保存…" : "确认修改并登录"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full h-8 text-xs text-muted-foreground hover:text-foreground"
              onClick={onLogout}
              disabled={submitting}
            >
              <LogOut className="h-3.5 w-3.5 mr-1" />
              退出登录
            </Button>
          </CardContent>
        </form>
      </Card>
    </div>
  );
};
