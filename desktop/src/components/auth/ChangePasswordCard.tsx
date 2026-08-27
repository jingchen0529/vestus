import React, { useState } from "react";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { authService } from "@/services/authService";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";

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
    <div className="min-h-screen w-full bg-slate-950 p-4 flex items-center justify-center">
      <Card className="w-full max-w-md border-slate-800 bg-slate-900/90 shadow-2xl">
        <CardHeader>
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <CardTitle className="text-base text-slate-100">请修改临时密码</CardTitle>
          <CardDescription className="text-xs text-slate-400">
            账号 {username} 的临时密码由管理员重置。修改后需要使用新密码重新登录。
          </CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className="space-y-4">
            {message && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {message}
              </div>
            )}
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder="当前临时密码"
              icon={<KeyRound className="h-4 w-4" />}
              disabled={submitting}
              autoFocus
              required
            />
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="新密码（至少 6 个字符）"
              icon={<KeyRound className="h-4 w-4" />}
              disabled={submitting}
              minLength={6}
              required
            />
            <Input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="再次输入新密码"
              icon={<KeyRound className="h-4 w-4" />}
              disabled={submitting}
              minLength={6}
              required
            />
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "正在更新…" : "修改密码并重新登录"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={submitting}
              onClick={() => void onLogout()}
            >
              <LogOut className="mr-2 h-4 w-4" />
              退出并返回登录
            </Button>
          </CardContent>
        </form>
      </Card>
    </div>
  );
};
