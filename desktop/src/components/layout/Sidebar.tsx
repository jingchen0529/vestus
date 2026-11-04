import React from "react";
import {
  LayoutGrid,
  Settings,
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

const NAV_ITEMS: { id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "platforms", label: "平台入口", icon: LayoutGrid },
  { id: "settings", label: "系统配置", icon: Settings },
];

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
    <aside className="flex h-screen w-52 shrink-0 select-none flex-col justify-between border-r border-border/70 bg-card transition-colors">
      <div className="flex flex-col gap-5">
        {/* 品牌区（可拖拽） */}
        <div
          data-tauri-drag-region
          className="flex cursor-default items-center gap-2.5 px-4 pt-9"
        >
          <img
            src={displayLogo}
            alt={productName}
            className="h-7 w-7 shrink-0 rounded-[8px] border border-border/70 bg-background object-contain p-0.5 shadow-xs"
          />
          <div className="min-w-0">
            <h1 className="truncate text-[13px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
              {productName}
            </h1>
            <p className="truncate text-[10px] leading-tight text-muted-foreground/70">
              全局代理浏览器
            </p>
          </div>
        </div>

        {/* 导航 */}
        <nav className="flex flex-col gap-0.5 px-2.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-[8px] py-[7px] pl-2.5 pr-2 text-left text-[12.5px] transition-colors duration-150",
                  isActive
                    ? "bg-primary/[0.09] font-semibold text-primary"
                    : "font-medium text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground",
                )}
              >
                {/* 选中指示条：比整块填色克制 */}
                <span
                  className={cn(
                    "absolute left-0 top-1/2 w-[2.5px] -translate-y-1/2 rounded-full bg-primary transition-all duration-200",
                    isActive ? "h-3.5 opacity-100" : "h-0 opacity-0",
                  )}
                />
                <Icon
                  className={cn(
                    "h-[15px] w-[15px] shrink-0 transition-colors",
                    isActive
                      ? "text-primary"
                      : "text-muted-foreground/70 group-hover:text-foreground",
                  )}
                />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* 底部：账号 + 操作 */}
      <div className="border-t border-border/70 p-2.5">
        <div className="flex items-center gap-2 rounded-[10px] px-1.5 py-1.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-primary/10 text-[11px] font-semibold text-primary">
            {userInitial}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[12px] font-medium leading-tight text-foreground"
              title={user.name}
            >
              {user.name}
            </div>
            <p
              className="truncate text-[10px] leading-tight text-muted-foreground/70"
              title={user.company || user.username}
            >
              {user.company || user.username}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <ThemeToggle
              variant="icon-button"
              className="h-6 w-6 rounded-md border-0 bg-transparent text-muted-foreground shadow-none hover:bg-foreground/[0.05] hover:text-foreground"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="退出登录"
              onClick={onLogout}
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
};
