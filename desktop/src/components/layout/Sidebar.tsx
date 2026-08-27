import React from "react";
import {
  LayoutGrid,
  Settings,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAccount } from "@/services/authService";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";

import defaultLogo from "@/assets/logo.png";

export type NavTab = "platforms" | "settings";

interface SidebarProps {
  productName: string;
  logoUrl?: string;
  user: UserAccount;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  productName,
  logoUrl,
  user,
  activeTab,
  onSelectTab,
  onLogout,
}) => {
  const userInitial = user.name ? user.name.slice(0, 1) : "用";
  const displayLogo = logoUrl || defaultLogo;

  return (
    <aside className="w-56 shrink-0 h-screen border-r border-border bg-white dark:bg-card/90 flex flex-col justify-between p-3 pt-8 select-none transition-colors">
      {/* Top: Brand & Navigation */}
      <div className="flex flex-col gap-4">
        {/* Brand Header */}
        <div data-tauri-drag-region className="flex items-center gap-2.5 px-2 py-2 cursor-default">
          <img
            src={displayLogo}
            alt={productName}
            className="w-8 h-8 rounded-lg object-contain border border-border/60 bg-background shadow-xs shrink-0"
          />
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-foreground tracking-tight truncate leading-tight">
              {productName}
            </h1>
            <p className="text-[10px] text-muted-foreground truncate">
              专属代理浏览器
            </p>
          </div>
        </div>

        {/* Navigation Menus */}
        <nav className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => onSelectTab("platforms")}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all text-left",
              activeTab === "platforms"
                ? "bg-primary/10 text-primary font-semibold dark:bg-primary/20"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
          >
            <LayoutGrid className="w-4 h-4 shrink-0" />
            <span>平台管理</span>
          </button>

          <button
            type="button"
            onClick={() => onSelectTab("settings")}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all text-left",
              activeTab === "settings"
                ? "bg-primary/10 text-primary font-semibold dark:bg-primary/20"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span>系统配置</span>
          </button>
        </nav>
      </div>

      {/* Bottom: Theme Toggle & User Info & Logout */}
      <div className="flex flex-col gap-2.5 pt-3 border-t border-border/80">
        {/* Theme Quick Switcher */}
        <div className="px-1">
          <ThemeToggle variant="segmented" className="w-full justify-between" />
        </div>

        {/* User Info Block */}
        <div className="flex items-center justify-between gap-2 p-2 rounded-xl bg-muted/40 border border-border/60">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary border border-primary/20 flex items-center justify-center text-xs font-bold shrink-0">
              {userInitial}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="text-xs font-semibold text-foreground truncate">
                  {user.name}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground truncate">
                {user.company || user.username}
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-500/10 rounded-lg shrink-0"
            title="退出登录"
            onClick={onLogout}
          >
            <LogOut className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </aside>
  );
};
