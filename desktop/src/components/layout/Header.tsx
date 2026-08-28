import React from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UserAccount } from "@/services/authService";
import { ThemeToggle } from "./ThemeToggle";
import defaultLogo from "@/assets/logo.png";

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
    <header className="h-16 border-b border-border bg-white dark:bg-card/90 backdrop-blur-xl px-4 flex items-center justify-between sticky top-0 z-40 transition-colors">
      {/* Left Brand info */}
      <div className="flex items-center gap-3">
        <img
          src={defaultLogo}
          alt={productName}
          className="w-9 h-9 rounded-xl object-contain border border-border/60 bg-background shadow-xs shrink-0"
        />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold text-foreground tracking-tight">{productName}</h1>
          </div>
          <p className="text-[11px] text-muted-foreground hidden sm:block">
            全局代理浏览器
          </p>
        </div>
      </div>

      {/* Right Controls & Desktop User */}
      <div className="flex items-center gap-3">
        {/* Theme Mode Switcher */}
        <ThemeToggle />

        {/* User Badge Info */}
        <div className="flex items-center gap-2.5 pl-3 border-l border-border">
          <div className="text-right hidden sm:block">
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-xs font-semibold text-foreground">{user.name}</span>
              <Badge
                variant="info"
                className="text-[10px] py-0 px-1.5 font-normal"
              >
                桌面端用户
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground truncate max-w-[140px]">
              {user.company || user.username}
            </p>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-500/10 rounded-lg"
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
