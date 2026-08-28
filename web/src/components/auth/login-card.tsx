import React, { useState, useEffect } from "react";
import { Lock, User, Eye, EyeOff, AlertCircle, Sparkles } from "lucide-react";
import defaultLogo from "@/assets/logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

export function LoginCard() {
  const { login } = useAuth();
  const { adminTitle, adminLogoUrl, setAdminLogoUrl, setAdminTitle } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getProduct()
      .then((res) => {
        if (res.logoUrl && !adminLogoUrl) {
          setAdminLogoUrl(res.logoUrl);
        }
        if (res.productName && (!adminTitle || adminTitle === "Vestus Admin")) {
          setAdminTitle(`${res.productName} 管理后台`);
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入管理员账号和密码");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const user = await login(username.trim(), password);
      toast.success(`欢迎回来，${user.name}！`, {
        description: `当前身份：${user.role === "super_admin" ? "超级管理员" : "普通管理员"}`,
      });
    } catch (err: any) {
      const msg = err.message || "登录失败，请核对账号密码";
      setError(msg);
      toast.error("登录失败", { description: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const displayLogo = adminLogoUrl || defaultLogo;
  const displayTitle = adminTitle || "Vestus 管理后台";

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center p-4 bg-slate-50 text-slate-900 overflow-hidden selection:bg-primary/20 selection:text-primary">
      {/* Background Decorative Subtle Gradients */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-slate-200/40 rounded-full blur-3xl pointer-events-none" />

      <Card className="w-full max-w-md border border-slate-200/80 bg-white/95 backdrop-blur-xl shadow-xl shadow-slate-200/60 rounded-2xl relative z-10 text-slate-900 transition-all">
        <CardHeader className="space-y-3 text-center pb-6 border-b border-slate-100">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200/80 bg-slate-50/80 shadow-sm p-2">
            <img src={displayLogo} alt="Logo" className="h-full w-full object-contain" />
          </div>
          <div>
            <div className="flex items-center justify-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary mb-1">
              <Sparkles className="h-3.5 w-3.5" />
              <span>VESTUS MANAGEMENT CONSOLE</span>
            </div>
            <CardTitle className="text-2xl font-bold tracking-tight text-slate-900">
              {displayTitle}
            </CardTitle>
            <CardDescription className="text-slate-500 text-xs mt-1">
              管理员、桌面端用户、全局共享代理与审计日志统一控制中心
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="pt-6">
          {error && (
            <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50/90 p-3 text-xs text-red-600 animate-in fade-in-50">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-500" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username" className="text-xs text-slate-700 font-medium">
                管理员账号
              </Label>
              <div className="relative">
                <User className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  id="username"
                  type="text"
                  placeholder="请输入管理员账号"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="pl-9 bg-slate-50/70 border-slate-200 text-slate-900 placeholder:text-slate-400 focus-visible:ring-primary focus-visible:bg-white h-10 transition-colors"
                  autoComplete="username"
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-xs text-slate-700 font-medium">
                登录密码
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="请输入登录密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9 pr-9 bg-slate-50/70 border-slate-200 text-slate-900 placeholder:text-slate-400 focus-visible:ring-primary focus-visible:bg-white h-10 transition-colors"
                  autoComplete="current-password"
                  required
                  disabled={isLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 focus:outline-none transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-10 mt-2 bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-600/90 text-white font-semibold shadow-md shadow-primary/25"
              loading={isLoading}
            >
              安全登录
            </Button>
          </form>

          <div className="mt-6 text-center text-xs text-slate-400">
            仅限受权系统管理员登录 · 审计日志实时记录
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
