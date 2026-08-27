import React, { useEffect, useState } from "react";
import { Lock, User, ShieldCheck, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { authService, UserAccount } from "@/services/authService";
import { useToast } from "@/components/ui/toast";

interface LoginCardProps {
  productName: string;
  notice?: string | null;
  onLoginSuccess: (user: UserAccount) => void;
}

export const LoginCard: React.FC<LoginCardProps> = ({ productName, notice, onLoginSuccess }) => {
  const { success, error } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-950 p-4 relative overflow-hidden">
      {/* Background Decorative Gradients */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-blue-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-indigo-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-[40%] left-[60%] w-[350px] h-[350px] bg-emerald-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 shadow-xl shadow-blue-500/25 mb-3 border border-blue-400/30">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center justify-center gap-2">
            {productName} 桌面客户端
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            使用管理员分配的账号登录专属浏览器
          </p>
        </div>

        <Card className="border-slate-800 bg-slate-900/80 backdrop-blur-xl shadow-2xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-base text-slate-100">桌面端用户登录</CardTitle>
            <CardDescription className="text-xs text-slate-400">
              请使用管理员为您分配的专属账号和密码登录后使用本软件。
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {errMsg && (
                <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                  <span>{errMsg}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                  <span>桌面端账号</span>
                </label>
                <Input
                  type="text"
                  placeholder="请输入管理员为您分配的桌面端账号"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  icon={<User className="w-4 h-4" />}
                  autoFocus
                  disabled={loading}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                  <span>登录密码</span>
                </label>
                <Input
                  type="password"
                  placeholder="请输入登录密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  icon={<Lock className="w-4 h-4" />}
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
