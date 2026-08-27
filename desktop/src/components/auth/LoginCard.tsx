import React, { useEffect, useState } from "react";
import { Lock, User, Eye, EyeOff, ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { authService, UserAccount } from "@/services/authService";
import { useToast } from "@/components/ui/toast";

import defaultLogo from "@/assets/logo.png";

interface LoginCardProps {
  productName: string;
  logoUrl?: string;
  notice?: string | null;
  onLoginSuccess: (user: UserAccount) => void;
}

export const LoginCard: React.FC<LoginCardProps> = ({
  productName,
  logoUrl,
  notice,
  onLoginSuccess,
}) => {
  const { success, error } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(notice || null);

  useEffect(() => {
    setErrMsg(notice || null);
  }, [notice]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setErrMsg("请输入账号");
      return;
    }
    if (!password) {
      setErrMsg("请输入密码");
      return;
    }

    setLoading(true);
    setErrMsg(null);

    try {
      const user = await authService.login(username, password);
      success("登录成功", `欢迎回来，${user.name}（桌面端用户）`);
      onLoginSuccess(user);
    } catch (err: any) {
      const msg = err.message || "登录失败，请检查账号密码";
      setErrMsg(msg);
      error("登录失败", msg);
    } finally {
      setLoading(false);
    }
  };

  const displayLogo = logoUrl || defaultLogo;

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground p-4 relative overflow-hidden transition-colors">
      {/* Draggable window header region */}
      <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-10 z-50 select-none cursor-default" />

      {/* Background Decorative Gradients */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-blue-600/10 dark:bg-blue-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-indigo-600/10 dark:bg-indigo-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-[40%] left-[60%] w-[350px] h-[350px] bg-emerald-600/5 dark:bg-emerald-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        <Card className="border-border bg-card/90 backdrop-blur-xl shadow-xl">
          <CardHeader className="pb-4 pt-6 flex flex-col items-center justify-center text-center">
            <div className="flex flex-col items-center justify-center gap-3 w-full">
              <img
                src={displayLogo}
                alt={productName || "Logo"}
                className="w-12 h-12 object-contain rounded-2xl border border-border/60 bg-background shadow-sm shrink-0"
              />
              <div className="min-w-0 max-w-full">
                <CardTitle className="text-base font-bold text-foreground text-center truncate">
                  {productName || "Vestus"}
                </CardTitle>
              </div>
            </div>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {errMsg && (
                <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-300 text-xs flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-rose-500 dark:bg-rose-400 shrink-0" />
                  <span>{errMsg}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground flex items-center justify-between">
                  <span>登录账号</span>
                </label>
                <Input
                  type="text"
                  placeholder="请输入管理员为您分配的登录账号"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  icon={<User className="w-4 h-4" />}
                  autoFocus
                  disabled={loading}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground flex items-center justify-between">
                  <span>登录密码</span>
                </label>
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="请输入登录密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  icon={<Lock className="w-4 h-4" />}
                  rightElement={
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowPassword(!showPassword)}
                      className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded focus:outline-none"
                      title={showPassword ? "隐藏密码" : "显示密码"}
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  }
                  disabled={loading}
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium shadow-lg shadow-blue-500/25 h-10 mt-2"
                disabled={loading}
              >
                {loading ? "正在验证身份…" : "立即登录系统"}
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            </CardContent>
          </form>
        </Card>
      </div>
    </div>
  );
};
