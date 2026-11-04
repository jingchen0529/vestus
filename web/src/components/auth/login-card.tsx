import React, { useState } from "react";
import { Lock, User, Eye, EyeOff, AlertCircle, ArrowRight } from "lucide-react";
import defaultLogo from "@/assets/logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { toast } from "sonner";

export function LoginCard() {
  const { login } = useAuth();
  const { adminTitle, adminLogoUrl } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="grid min-h-[100dvh] w-full bg-background lg:grid-cols-[1.02fr_1fr]">
      {/* ── 左：品牌面板 ───────────────────────────── */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[hsl(220_18%_8%)] p-12 text-[hsl(40_20%_94%)] lg:flex bg-noise">
        <div className="pointer-events-none absolute inset-0 bg-grid-dark opacity-60" />
        {/* 单一光源：左下角一抹青色，不做多彩渐变球 */}
        <div
          className="pointer-events-none absolute -left-32 bottom-0 h-[520px] w-[520px] rounded-full opacity-[0.18] blur-[120px]"
          style={{ background: "hsl(168 68% 40%)" }}
        />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-white/[0.08]" />

        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-white/10 bg-white/[0.06] p-1.5">
            <img src={displayLogo} alt="Logo" className="h-full w-full object-contain" />
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-[0.16em] text-white/90">
              VESTUS
            </div>
            <div className="text-[11px] tracking-[0.1em] text-white/35">
              MANAGEMENT CONSOLE
            </div>
          </div>
        </div>

        <div className="relative max-w-[30rem]">
          <div className="mb-6 flex items-center gap-2 text-[11px] tracking-[0.2em] text-white/35">
            <span className="h-1 w-1 rounded-full bg-[hsl(168_60%_48%)]" />
            统一控制中心
          </div>
          <h1 className="font-display text-[42px] leading-[1.08] text-white/95">
            账号、权限与审计，
            <br />
            收进同一个控制台。
          </h1>
          <p className="mt-5 max-w-[34ch] text-[13.5px] leading-[1.75] text-white/45">
            管理员、桌面端用户、全局共享代理与操作日志，统一纳管、逐条留痕，不必在多个系统之间来回切换。
          </p>
        </div>

        <div className="relative flex w-full flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/[0.08] pt-5 text-[11.5px] tracking-wide text-white/35">
          <span>管理员权限</span>
          <span className="h-3 w-px bg-white/10" />
          <span>桌面端会话</span>
          <span className="h-3 w-px bg-white/10" />
          <span>代理与审计</span>
        </div>
      </aside>

      {/* ── 右：登录表单 ───────────────────────────── */}
      <main className="relative flex items-center justify-center px-6 py-16">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-40" />

        <div className="relative w-full max-w-[392px] animate-fade-up">
          {/* 小屏时补一个品牌行 */}
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-border bg-card p-1.5">
              <img src={displayLogo} alt="Logo" className="h-full w-full object-contain" />
            </div>
            <span className="text-[13px] font-semibold tracking-[0.14em] text-foreground/80">
              VESTUS
            </span>
          </div>

          <div className="mb-8">
            <h2 className="text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] text-foreground">
              {displayTitle}
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              使用管理员账号进入，所有操作将实时记入审计日志。
            </p>
          </div>

          {error && (
            <div className="mb-6 flex items-start gap-2.5 rounded-[10px] border border-destructive/25 bg-destructive/[0.06] px-3.5 py-3 text-[12.5px] leading-relaxed text-destructive animate-in fade-in-50">
              <AlertCircle className="mt-[1px] h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label
                htmlFor="username"
                className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground"
              >
                管理员账号
              </Label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  id="username"
                  type="text"
                  placeholder="请输入管理员账号"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="h-11 rounded-[10px] border-input bg-card pl-10 text-[13.5px] shadow-xs transition-[border-color,box-shadow] placeholder:text-muted-foreground/55 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15"
                  autoComplete="username"
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="password"
                className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground"
              >
                登录密码
              </Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="请输入登录密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 rounded-[10px] border-input bg-card pl-10 pr-10 text-[13.5px] shadow-xs transition-[border-color,box-shadow] placeholder:text-muted-foreground/55 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15"
                  autoComplete="current-password"
                  required
                  disabled={isLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                  tabIndex={-1}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
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
              loading={isLoading}
              className="group mt-1 h-11 w-full rounded-[10px] bg-primary text-[13.5px] font-semibold tracking-wide text-primary-foreground shadow-soft transition-all hover:bg-primary/92 hover:shadow-lift active:scale-[0.995]"
            >
              进入控制台
              <ArrowRight className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Button>
          </form>

        </div>
      </main>
    </div>
  );
}
