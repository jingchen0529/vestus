import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { UserPlus, Server, Globe, ShieldPlus, FileText } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { NavTab } from "@/components/layout/sidebar";

interface QuickActionsProps {
  onNavigate: (tab: NavTab) => void;
  onOpenCreateUser: () => void;
  onOpenCreateProxy: () => void;
  onOpenCreatePlatform: () => void;
  onOpenCreateAdmin?: () => void;
}

export function QuickActions({
  onNavigate,
  onOpenCreateUser,
  onOpenCreateProxy,
  onOpenCreatePlatform,
  onOpenCreateAdmin,
}: QuickActionsProps) {
  const { isSuperAdmin } = useAuth();

  return (
    <Card className="border-border/80">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span>常用快捷管理操作</span>
          <span className="text-xs font-normal text-muted-foreground">
            快速配置与业务流转
          </span>
        </CardTitle>
        <CardDescription className="text-xs">
          一键开通受权账号、扩展代理节点或维护平台入口
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {/* Create User Button */}
          <button
            onClick={onOpenCreateUser}
            className="flex items-center gap-3 p-3 rounded-lg border border-border/80 bg-card hover:bg-accent hover:border-primary/40 transition-all text-left group shadow-sm"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 group-hover:scale-110 transition-transform">
              <UserPlus className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold group-hover:text-primary transition-colors">
                开通桌面账号
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                录入新用户与授权期限
              </div>
            </div>
          </button>

          {/* Create Proxy Button */}
          <button
            onClick={onOpenCreateProxy}
            className="flex items-center gap-3 p-3 rounded-lg border border-border/80 bg-card hover:bg-accent hover:border-emerald-500/40 transition-all text-left group shadow-sm"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 group-hover:scale-110 transition-transform">
              <Server className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold group-hover:text-emerald-600 transition-colors">
                添加专属代理
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                绑定安全上游代理池
              </div>
            </div>
          </button>

          {/* Create Platform Button */}
          <button
            onClick={onOpenCreatePlatform}
            className="flex items-center gap-3 p-3 rounded-lg border border-border/80 bg-card hover:bg-accent hover:border-indigo-500/40 transition-all text-left group shadow-sm"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 group-hover:scale-110 transition-transform">
              <Globe className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold group-hover:text-indigo-600 transition-colors">
                配置快捷平台
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                下发桌面端业务网址
              </div>
            </div>
          </button>

          {/* Super Admin Action or Logs Button */}
          {isSuperAdmin && onOpenCreateAdmin ? (
            <button
              onClick={onOpenCreateAdmin}
              className="flex items-center gap-3 p-3 rounded-lg border border-border/80 bg-card hover:bg-accent hover:border-primary/40 transition-all text-left group shadow-sm"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:scale-110 transition-transform">
                <ShieldPlus className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold group-hover:text-primary transition-colors">
                  新增管理员
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  分配系统管理权限
                </div>
              </div>
            </button>
          ) : (
            <button
              onClick={() => onNavigate("logs")}
              className="flex items-center gap-3 p-3 rounded-lg border border-border/80 bg-card hover:bg-accent hover:border-slate-500/40 transition-all text-left group shadow-sm"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-500/10 text-slate-600 group-hover:scale-110 transition-transform">
                <FileText className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold group-hover:text-foreground transition-colors">
                  查看审计日志
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  安全事件溯源追踪
                </div>
              </div>
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
