import { useState, useEffect } from "react";
import type { ComponentType } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { api } from "@/lib/api-client";
import { SystemHealth } from "@/types/api";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Sliders,
  ShieldCheck,
  FileText,
  Activity,
  ChevronLeft,
  ChevronRight,
  Shield,
  Layers,
  LogOut,
  KeyRound,
  ChevronsUpDown,
  Sun,
  Moon,
  Laptop,
  Server,
  Database,
  RefreshCw,
  Globe,
  Link2,
  MessageSquareText,
  FolderTree,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type NavTab = "dashboard" | "users" | "bindings" | "desktop" | "platforms" | "faq" | "faq-groups" | "admins" | "activity" | "logs" | "settings";

interface NavItem {
  id: NavTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
  badge?: string | null;
  badgeVariant?: "primary" | "secondary" | "destructive" | "outline";
  badgeTitle?: string;
  requiresSuperAdmin?: boolean;
  group: string;
}

export function isSuperAdminTab(tab: NavTab): boolean {
  // 「帮助分组」是结构配置（增删栏目、调整顺序），只对超管开放；
  // 「帮助内容」对所有管理员可见，普通管理员进只读列表。
  return ["admins", "desktop", "settings", "bindings", "faq-groups"].includes(tab);
}

interface SidebarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChangePassword: () => void;
  userStatsTotal?: number;
  platformsTotal?: number;
  proxiesTotal?: number;
  expiredBindingsCount?: number;
}

export function Sidebar({
  currentTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  onChangePassword,
  userStatsTotal,
  platformsTotal,
  proxiesTotal,
  expiredBindingsCount,
}: SidebarProps) {
  const {
    user,
    isSuperAdmin,
    logout,
  } = useAuth();
  const {
    theme,
    setTheme,
    adminTitle,
    adminLogoUrl,
  } = useTheme();

  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [isHealthLoading, setIsHealthLoading] = useState(false);

  const fetchHealthStatus = async () => {
    setIsHealthLoading(true);
    try {
      setHealth(await api.getHealth());
    } catch {
      // ignore
    } finally {
      setIsHealthLoading(false);
    }
  };

  useEffect(() => {
    fetchHealthStatus();
  }, []);

  const getInitials = (name?: string) => {
    if (!name) return "AD";
    return name.slice(0, 2).toUpperCase();
  };

  const mainNavItems: NavItem[] = [
    {
      id: "dashboard",
      label: "控制总览",
      icon: LayoutDashboard,
      group: "总览",
    },
    {
      id: "users",
      label: "桌面用户",
      icon: Users,
      badge: userStatsTotal !== undefined ? `${userStatsTotal}` : null,
      group: "业务运营",
    },
    {
      id: "bindings",
      label: "绑定托管",
      icon: Link2,
      requiresSuperAdmin: true,
      badge:
        expiredBindingsCount !== undefined && expiredBindingsCount > 0
          ? `${expiredBindingsCount}`
          : null,
      badgeVariant: "destructive",
      badgeTitle:
        expiredBindingsCount && expiredBindingsCount > 0
          ? `${expiredBindingsCount} 个托管会话已失效，点击查看`
          : undefined,
      group: "业务运营",
    },
    {
      id: "desktop",
      label: "代理管理",
      icon: Server,
      badge: proxiesTotal !== undefined ? `${proxiesTotal}` : null,
      requiresSuperAdmin: true,
      group: "业务运营",
    },
    {
      id: "platforms",
      label: "平台管理",
      icon: Globe,
      badge: platformsTotal !== undefined ? `${platformsTotal}` : null,
      group: "业务运营",
    },
    {
      id: "faq",
      label: "帮助内容",
      icon: MessageSquareText,
      group: "业务运营",
    },
    {
      id: "faq-groups",
      label: "帮助分组",
      icon: FolderTree,
      requiresSuperAdmin: true,
      group: "业务运营",
    },
    {
      id: "activity",
      label: "会话追踪",
      icon: Activity,
      group: "监控与审计",
    },
    {
      id: "logs",
      label: "审计日志",
      icon: FileText,
      group: "监控与审计",
    },
    {
      id: "admins",
      label: "系统管理",
      icon: ShieldCheck,
      badge: isSuperAdmin ? "超管" : null,
      badgeVariant: "primary",
      requiresSuperAdmin: true,
      group: "权限",
    },
  ];

  const bottomNavItems: NavItem[] = [
    {
      id: "settings",
      label: "系统配置",
      icon: Sliders,
      requiresSuperAdmin: true,
      group: "权限",
    },
  ];

  const visibleMainNavItems = mainNavItems.filter(
    (item) => !isSuperAdminTab(item.id) || isSuperAdmin
  );
  const visibleBottomNavItems = bottomNavItems.filter(
    (item) => !isSuperAdminTab(item.id) || isSuperAdmin
  );

  const renderNavButton = (item: NavItem) => {
    const Icon = item.icon;
    const isActive = currentTab === item.id;

    return (
      <button
        key={item.id}
        onClick={() => onTabChange(item.id)}
        title={collapsed ? item.label : undefined}
        className={cn(
          "group relative flex w-full items-center gap-2.5 rounded-[8px] py-2 text-[13px] transition-colors duration-150",
          collapsed ? "justify-center px-0" : "pl-3 pr-2.5",
          isActive
            ? "bg-primary/[0.09] font-semibold text-primary"
            : "font-medium text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground",
        )}
      >
        {/* 选中指示条：比整块填色克制，视觉重心仍在内容区 */}
        <span
          className={cn(
            "absolute left-0 top-1/2 w-[2.5px] -translate-y-1/2 rounded-full bg-primary transition-all duration-200",
            isActive ? "h-4 opacity-100" : "h-0 opacity-0",
          )}
        />
        <Icon
          className={cn(
            "h-[17px] w-[17px] shrink-0 transition-colors",
            isActive ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground",
          )}
        />

        {collapsed && item.id === "bindings" && item.badge && (
          <Badge
            variant="destructive"
            className="absolute right-0 top-0 px-1 py-0 text-[9px]"
            title={item.badgeTitle}
          >
            {item.badge}
          </Badge>
        )}
        {!collapsed && (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate">{item.label}</span>
            {item.badge && (
              <span
                className={cn(
                  "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : item.badgeVariant === "destructive"
                      ? "animate-pulse bg-destructive/10 text-destructive"
                      : "bg-muted text-muted-foreground",
                )}
                title={item.badgeTitle}
              >
                {item.badge}
              </span>
            )}
          </div>
        )}
      </button>
    );
  };

  const navGroups = visibleMainNavItems.reduce<Record<string, NavItem[]>>(
    (acc, item) => {
      (acc[item.group] ||= []).push(item);
      return acc;
    },
    {},
  );

  return (
    <aside
      className={cn(
        "relative z-20 flex shrink-0 select-none flex-col border-r border-border/70 bg-card transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Brand Header */}
      <div className="flex h-16 items-center justify-between border-b border-border/70 px-4">
        {!collapsed ? (
          <div className="flex items-center gap-3 overflow-hidden">
            {adminLogoUrl ? (
              <img
                src={adminLogoUrl}
                alt="Admin Logo"
                className="h-9 w-9 shrink-0 object-contain rounded-xl border border-border/60 bg-background shadow-xs"
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-soft">
                <Layers className="h-5 w-5" />
              </div>
            )}
            <div className="flex flex-col overflow-hidden">
              <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                {adminTitle || "Vestus Admin"}
              </span>
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/60">
                Control Console
              </span>
            </div>
          </div>
        ) : (
          adminLogoUrl ? (
            <img
              src={adminLogoUrl}
              alt="Admin Logo"
              className="mx-auto h-9 w-9 object-contain rounded-xl border border-border/60 bg-background"
            />
          ) : (
            <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-soft">
              <Layers className="h-5 w-5" />
            </div>
          )
        )}

        <button
          onClick={onToggleCollapse}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
            collapsed && "mx-auto mt-1"
          )}
          title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Main Navigation List */}
      <div className="flex-1 space-y-5 overflow-y-auto px-2 py-4">
        {Object.entries(navGroups).map(([group, items]) => (
          <div key={group} className="space-y-0.5">
            {!collapsed && (
              <div className="px-3 pb-1.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/55">
                {group}
              </div>
            )}
            {collapsed && <div className="mx-auto mb-1 h-px w-6 bg-border/70" />}
            {items.map(renderNavButton)}
          </div>
        ))}
      </div>

      {/* Bottom Pinned System Settings (directly above user profile) */}
      {visibleBottomNavItems.length > 0 && (
        <div className="p-2 border-t space-y-1 bg-card/30">
          {visibleBottomNavItems.map(renderNavButton)}
        </div>
      )}

      {/* Admin Status / Profile at Bottom Left */}
      <div className="p-2 border-t mt-auto bg-card/50">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg p-2 text-left transition-all hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                collapsed ? "justify-center px-0" : "px-2"
              )}
              title={collapsed ? `${user?.name || "系统管理员"} (@${user?.username || "admin"})` : undefined}
            >
              <div className="relative shrink-0">
                <Avatar className="h-9 w-9 border border-border/80 shadow-sm">
                  <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                    {getInitials(user?.name)}
                  </AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-card",
                    user?.status === "active" ? "bg-success" : "bg-warning"
                  )}
                  title={user?.status === "active" ? "状态正常" : "状态受限"}
                />
              </div>

              {!collapsed && (
                <div className="flex flex-1 items-center justify-between min-w-0 overflow-hidden">
                  <div className="flex flex-col text-left truncate mr-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="text-xs font-semibold text-foreground truncate">
                        {user?.name || "系统管理员"}
                      </span>
                      {user?.role === "super_admin" ? (
                        <Badge variant="primary" className="text-[9px] px-1 py-0 h-4">
                          超管
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">
                          普管
                        </Badge>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground truncate font-mono">
                      @{user?.username || "admin"}
                    </span>
                  </div>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                </div>
              )}
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side="right"
            align="end"
            sideOffset={12}
            className="w-72 p-2.5 shadow-2xl border-border/80 rounded-xl"
          >
            {/* Header: Admin Info Card */}
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/40 border border-border/50 mb-2">
              <div className="flex flex-col space-y-0.5 truncate mr-2">
                <p className="text-xs font-bold text-foreground truncate">
                  {user?.name || "系统管理员"}
                </p>
                <span className="text-[10px] text-muted-foreground truncate font-mono">
                  @{user?.username || "admin"}
                </span>
              </div>
              <Badge
                variant={user?.role === "super_admin" ? "primary" : "secondary"}
                className="text-[10px] px-1.5 py-0 shrink-0 font-medium"
              >
                {user?.role === "super_admin" ? "超级管理员" : "普通管理员"}
              </Badge>
            </div>

            {/* Unified Sleek System Runtime Health Card */}
            <div className="rounded-lg bg-muted/30 border border-border/50 p-2.5 my-1.5 space-y-2">
              <div className="flex items-center justify-between pb-1 border-b border-border/40">
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                  </span>
                  <span className="text-[11px] font-semibold text-foreground">
                    系统环境状态
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    fetchHealthStatus();
                  }}
                  disabled={isHealthLoading}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/80"
                  title="刷新系统健康探测"
                >
                  <RefreshCw className={cn("h-3 w-3", isHealthLoading && "animate-spin text-primary")} />
                  <span>探测</span>
                </button>
              </div>

              <div className="space-y-1">
                {/* Status 1: API Gateway */}
                <div className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-muted/40 transition-colors">
                  <div className="flex items-center gap-2">
                    <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary">
                      <Server className="h-3 w-3" />
                    </div>
                    <span className="text-[11px] text-foreground font-medium">API 网关</span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-success font-medium">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                    <span>
                      {health?.status
                        ? health.status === "HEALTHY" || health.status === "ok"
                          ? "正常"
                          : health.status
                        : "正常"}
                    </span>
                  </div>
                </div>

                {/* Status 2: Database Storage Engine */}
                <div className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-muted/40 transition-colors">
                  <div className="flex items-center gap-2">
                    <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary">
                      <Database className="h-3 w-3" />
                    </div>
                    <span className="text-[11px] text-foreground font-medium">持久层数据库</span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-success font-medium">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                    <span>{health?.database ? "已就绪" : "已连接"}</span>
                  </div>
                </div>

                {/* Status 3: Enterprise Core */}
                <div className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-muted/40 transition-colors">
                  <div className="flex items-center gap-2">
                    <div className="flex h-5 w-5 items-center justify-center rounded bg-success/10 text-success">
                      <Shield className="h-3 w-3" />
                    </div>
                    <span className="text-[11px] text-foreground font-medium">企业内核</span>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded border border-border/40">
                    v2.0.0
                  </span>
                </div>
              </div>
            </div>

            <DropdownMenuSeparator className="my-2" />

            {/* Modern Segmented Theme Switcher */}
            <div className="px-1 py-1 my-0.5">
              <div className="flex items-center justify-between px-1 mb-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">
                  外观主题
                </span>
                <span className="text-[10px] text-muted-foreground/80">
                  {theme === "dark" ? "暗黑模式" : theme === "light" ? "明亮模式" : "跟随系统"}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1 bg-muted/60 p-1 rounded-lg border border-border/50">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setTheme("light");
                  }}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all",
                    theme === "light"
                      ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
                      : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                  )}
                  title="明亮模式"
                >
                  <Sun className={cn("h-3.5 w-3.5", theme === "light" ? "text-warning" : "")} />
                  <span>明亮</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setTheme("dark");
                  }}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all",
                    theme === "dark"
                      ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
                      : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                  )}
                  title="暗黑模式"
                >
                  <Moon className={cn("h-3.5 w-3.5", theme === "dark" ? "text-info" : "")} />
                  <span>暗黑</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setTheme("system");
                  }}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all",
                    theme === "system"
                      ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
                      : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                  )}
                  title="跟随系统"
                >
                  <Laptop className="h-3.5 w-3.5" />
                  <span>系统</span>
                </button>
              </div>
            </div>

            <DropdownMenuSeparator className="my-2" />

            {isSuperAdmin && (
              <DropdownMenuItem
                onSelect={onChangePassword}
                className="text-xs gap-2 py-2 px-2.5 rounded-lg cursor-pointer font-medium"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>修改密码</span>
              </DropdownMenuItem>
            )}

            {/* Logout Action */}
            <DropdownMenuItem
              onClick={() => logout()}
              className="text-xs gap-2 py-2 px-2.5 rounded-lg text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer font-medium"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>退出登录</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
