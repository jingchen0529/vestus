import React, { useEffect, useState } from "react";
import { Lock, User, Eye, EyeOff, ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authService, UserAccount } from "@/services/authService";
import { useToast } from "@/components/ui/toast";
import { sanitizeNoWhitespace, preventSpaceKeyDown } from "./authInputHelpers";

import defaultLogo from "@/assets/logo.png";

const REMEMBER_USERNAME_KEY = "vestus_desktop_remembered_username_v1";
const REMEMBER_PASSWORD_KEY = "vestus_desktop_remembered_password_v1";

function readRememberedUsername(): string {
  try {
    return sanitizeNoWhitespace(window.localStorage.getItem(REMEMBER_USERNAME_KEY) || "");
  } catch {
    return "";
  }
}

function readRememberedPassword(): string {
  try {
    const raw = window.localStorage.getItem(REMEMBER_PASSWORD_KEY);
    if (!raw) return "";
    return sanitizeNoWhitespace(decodeURIComponent(escape(window.atob(raw))));
  } catch {
    return "";
  }
}

function writeRememberedCredentials(username: string, password: string): void {
  try {
    const cleanUser = sanitizeNoWhitespace(username);
    const cleanPass = sanitizeNoWhitespace(password);
    if (cleanUser) {
      window.localStorage.setItem(REMEMBER_USERNAME_KEY, cleanUser);
      window.localStorage.setItem(REMEMBER_PASSWORD_KEY, window.btoa(unescape(encodeURIComponent(cleanPass))));
    } else {
      window.localStorage.removeItem(REMEMBER_USERNAME_KEY);
      window.localStorage.removeItem(REMEMBER_PASSWORD_KEY);
    }
  } catch {
    // Ignore unavailable storage.
  }
}

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
  const [username, setUsername] = useState(() => readRememberedUsername());
  const [password, setPassword] = useState(() => readRememberedPassword());
  const [rememberUsername, setRememberUsername] = useState(() => Boolean(readRememberedUsername()));
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(notice || null);

  useEffect(() => {
    setErrMsg(notice || null);
  }, [notice]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUsername = sanitizeNoWhitespace(username);
    const cleanPassword = sanitizeNoWhitespace(password);

    if (!cleanUsername) {
      setErrMsg("请输入账号");
      return;
    }
    if (!cleanPassword) {
      setErrMsg("请输入密码");
      return;
    }

    setLoading(true);
    setErrMsg(null);

    try {
      const user = await authService.login(cleanUsername, cleanPassword);
      if (rememberUsername) {
        writeRememberedCredentials(cleanUsername, cleanPassword);
      } else {
        writeRememberedCredentials("", "");
      }
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
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-y-auto bg-background px-5 py-4 text-foreground">
      {/* 拖拽区：窗口无边框，顶部整条可拖 */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-50 h-9 cursor-default select-none" />

      {/* 背景：无着色，只有极淡的中性网格与噪点 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_62%_52%_at_50%_44%,black,transparent_100%)]" />
        <div className="absolute inset-0 bg-noise opacity-70" />
      </div>

      {/* 居中单卡 */}
      <div className="relative z-10 my-auto w-full max-w-[344px]">
        <div className="rounded-[16px] border border-border/70 bg-card p-5 shadow-lift">
          {/* 品牌 */}
          <div className="flex flex-col items-center text-center">
            <img
              src={displayLogo}
              alt={productName || "Logo"}
              className="h-10 w-10 rounded-[11px] border border-border/70 bg-background object-contain p-1 shadow-xs"
            />
            <h1 className="mt-2.5 text-[15px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
              {productName || "Vestus"}
            </h1>
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              全局代理浏览器 · 桌面客户端
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-2.5">
            {errMsg && (
              <div className="flex items-start gap-2 rounded-[9px] border border-destructive/25 bg-destructive/[0.06] px-2.5 py-2">
                <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                <span className="text-[11px] leading-relaxed text-destructive">{errMsg}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">登录账号</label>
              <Input
                type="text"
                placeholder="请输入登录账号"
                value={username}
                onChange={(e) => setUsername(sanitizeNoWhitespace(e.target.value))}
                onKeyDown={preventSpaceKeyDown}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="username"
                icon={<User className="h-[15px] w-[15px]" />}
                className="h-10 rounded-[9px] bg-card font-mono text-[13px]"
                autoFocus={!username}
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">登录密码</label>
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="请输入登录密码"
                value={password}
                onChange={(e) => setPassword(sanitizeNoWhitespace(e.target.value))}
                onKeyDown={preventSpaceKeyDown}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="current-password"
                icon={<Lock className="h-[15px] w-[15px]" />}
                className="h-10 rounded-[9px] bg-card"
                rightElement={
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword(!showPassword)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                    title={showPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-[15px] w-[15px]" />
                    ) : (
                      <Eye className="h-[15px] w-[15px]" />
                    )}
                  </button>
                }
                autoFocus={Boolean(username) && !password}
                disabled={loading}
              />
            </div>

            <label className="flex w-fit cursor-pointer select-none items-center gap-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
              <input
                type="checkbox"
                checked={rememberUsername}
                onChange={(e) => setRememberUsername(e.target.checked)}
                disabled={loading}
                className="h-3.5 w-3.5 cursor-pointer rounded-[4px] border-border accent-[hsl(var(--primary))]"
              />
              记住登录信息
            </label>

            <Button
              type="submit"
              className="h-10 w-full gap-1.5 rounded-[9px] text-[13px] font-medium shadow-soft transition-all hover:shadow-lift active:scale-[0.995]"
              disabled={loading}
            >
              {loading ? "正在验证身份…" : "进入"}
              {!loading && <ArrowRight className="h-[15px] w-[15px]" />}
            </Button>
          </form>

          <div className="mt-3.5 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70">
            <ShieldCheck className="h-3 w-3 shrink-0" />
            <span>凭据仅在本机与服务器之间传输，不写入日志</span>
          </div>
        </div>

        <p className="mt-2 hidden text-center text-[10px] text-muted-foreground/60 [@media(min-height:520px)]:block">
          账号由管理员统一开通，忘记密码请联系管理员
        </p>
      </div>
    </div>
  );
};
