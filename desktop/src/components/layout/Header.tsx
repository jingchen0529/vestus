import React from "react";
import { ShieldCheck, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UserAccount } from "@/services/authService";

interface HeaderProps {
  productName: string;
  user: UserAccount;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  productName,
  user,
  onLogout,
}) => {
  return (
    <header className="h-16 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl px-4 flex items-center justify-between sticky top-0 z-40">
      {/* Left Brand info */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/20 border border-blue-400/30 shrink-0">
          <ShieldCheck className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold text-slate-100 tracking-tight">{productName}</h1>
          </div>
          <p className="text-[11px] text-slate-400 hidden sm:block">
            专属代理浏览器
          </p>
        </div>
      </div>

      {/* Right Desktop User */}
      <div className="flex items-center gap-2.5">
        {/* User Badge Info */}
        <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
          <div className="text-right hidden sm:block">
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-xs font-semibold text-slate-200">{user.name}</span>
              <Badge
                variant="info"
                className="text-[10px] py-0 px-1.5 font-normal"
              >
                桌面端用户
              </Badge>
            </div>
            <p className="text-[10px] text-slate-400 truncate max-w-[140px]">
              {user.company || user.username}
            </p>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg"
            title="退出登录"
            onClick={onLogout}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </header>
  );
};
