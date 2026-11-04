import { Card } from "@/components/ui/card";
import { UserPlus, Server, Globe, ShieldPlus, FileText, ArrowUpRight } from "lucide-react";
import type { ComponentType } from "react";
import { useAuth } from "@/hooks/use-auth";
import { NavTab } from "@/components/layout/sidebar";

interface QuickActionsProps {
  onNavigate: (tab: NavTab) => void;
  onOpenCreateUser: () => void;
  onOpenCreateProxy: () => void;
  onOpenCreatePlatform: () => void;
  onOpenCreateAdmin?: () => void;
}

interface ActionDef {
  key: string;
  title: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  tone?: "primary" | "success" | "muted";
}

export function QuickActions({
  onNavigate,
  onOpenCreateUser,
  onOpenCreateProxy,
  onOpenCreatePlatform,
  onOpenCreateAdmin,
}: QuickActionsProps) {
  const { isSuperAdmin } = useAuth();

  const actions: ActionDef[] = [
    {
      key: "user",
      title: "开通桌面账号",
      hint: "录入新用户与授权期限",
      icon: UserPlus,
      onClick: onOpenCreateUser,
      tone: "primary",
    },
    {
      key: "proxy",
      title: "添加代理节点",
      hint: "维护 VPN 节点池，可设默认",
      icon: Server,
      onClick: onOpenCreateProxy,
      tone: "success",
    },
    {
      key: "platform",
      title: "配置快捷平台",
      hint: "下发桌面端业务网址",
      icon: Globe,
      onClick: onOpenCreatePlatform,
      tone: "primary",
    },
    isSuperAdmin && onOpenCreateAdmin
      ? {
          key: "admin",
          title: "新增管理员",
          hint: "分配系统管理权限",
          icon: ShieldPlus,
          onClick: onOpenCreateAdmin,
          tone: "primary" as const,
        }
      : {
          key: "logs",
          title: "查看审计日志",
          hint: "安全事件溯源追踪",
          icon: FileText,
          onClick: () => onNavigate("logs"),
          tone: "muted" as const,
        },
  ];

  return (
    <Card className="overflow-hidden border-border/70 shadow-none">
      <div className="flex flex-col md:flex-row md:items-stretch">
        <div className="flex shrink-0 flex-col justify-center border-b border-border/60 px-5 py-4 md:w-[184px] md:border-b-0 md:border-r">
          <span className="text-[13px] font-medium tracking-[-0.01em] text-foreground">
            常用操作
          </span>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            一键开通账号、配置节点与平台入口
          </p>
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex min-w-max divide-x divide-border/60 md:grid md:min-w-0 md:grid-cols-2 xl:grid-cols-4">
            {actions.map((action) => {
              const Icon = action.icon;
              const tone = action.tone ?? "primary";
              return (
                <button
                  key={action.key}
                  onClick={action.onClick}
                  className="group relative flex w-[210px] items-start gap-2.5 px-4 py-4 text-left transition-colors hover:bg-accent/50 md:w-auto md:min-w-0"
                >
                  <Icon
                    className={
                      tone === "success"
                        ? "mt-0.5 h-4 w-4 shrink-0 text-success/70 transition-colors group-hover:text-success"
                        : tone === "muted"
                          ? "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                          : "mt-0.5 h-4 w-4 shrink-0 text-primary/60 transition-colors group-hover:text-primary"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 text-[12.5px] font-medium text-foreground">
                      <span className="truncate">{action.title}</span>
                      <ArrowUpRight className="h-3 w-3 shrink-0 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-60" />
                    </div>
                    <div className="mt-1 truncate text-[11px] leading-relaxed text-muted-foreground">
                      {action.hint}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}
