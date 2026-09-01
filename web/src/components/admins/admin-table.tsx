import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdminUser } from "@/types/admin";
import { formatDate, cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import {
  Edit2,
  KeyRound,
  PowerOff,
  Power,
  ShieldCheck,
  Clock,
  UserCheck,
  Trash2,
} from "lucide-react";

interface AdminTableProps {
  admins: AdminUser[];
  onEditAdmin: (admin: AdminUser) => void;
  onToggleStatus: (admin: AdminUser) => void;
  onResetPassword: (admin: AdminUser) => void;
  onDeleteAdmin: (admin: AdminUser) => void;
  isLoading?: boolean;
}

export function AdminTable({
  admins,
  onEditAdmin,
  onToggleStatus,
  onResetPassword,
  onDeleteAdmin,
}: AdminTableProps) {
  const { user: currentLoggedAdmin } = useAuth();

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">管理员账号</TableHead>
            <TableHead>姓名</TableHead>
            <TableHead className="w-[140px]">权限角色</TableHead>
            <TableHead className="w-[100px]">账号状态</TableHead>
            <TableHead className="w-[180px]">最后登录时间</TableHead>
            <TableHead className="w-[280px] text-right">操作管理</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {admins.map((admin) => {
            const isSelf = currentLoggedAdmin && String(currentLoggedAdmin.id) === String(admin.id);

            return (
              <TableRow key={admin.id} className="hover:bg-muted/40 transition-colors text-xs">
                {/* Username & ID */}
                <TableCell>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5 font-bold text-foreground text-sm tracking-tight">
                      <span>{admin.username}</span>
                      {isSelf && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 text-primary border-primary/30">
                          当前登录
                        </Badge>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">#{admin.id}</span>
                  </div>
                </TableCell>

                {/* Name */}
                <TableCell className="font-medium text-foreground">
                  {admin.name}
                </TableCell>

                {/* Role */}
                <TableCell>
                  {admin.role === "super_admin" ? (
                    <Badge variant="primary" className="gap-1 text-[10px]">
                      <ShieldCheck className="h-3 w-3" />
                      <span>超级管理员</span>
                    </Badge>
                  ) : (
                    <Badge variant="info" className="gap-1 text-[10px]">
                      <UserCheck className="h-3 w-3" />
                      <span>普通管理员</span>
                    </Badge>
                  )}
                </TableCell>

                {/* Status */}
                <TableCell>
                  {admin.status === "active" ? (
                    <Badge variant="success" className="text-[10px]">
                      正常
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">
                      已禁用
                    </Badge>
                  )}
                </TableCell>

                {/* Last Login */}
                <TableCell>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0" />
                    <span>{formatDate(admin.lastLoginAt)}</span>
                  </div>
                </TableCell>

                {/* Actions */}
                <TableCell className="text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditAdmin(admin)}
                      className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70 border border-border/40 hover:border-border/70 shadow-none font-normal transition-colors"
                    >
                      <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>编辑</span>
                    </Button>

                    {!isSelf && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onResetPassword(admin)}
                          className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 border border-border/40 hover:border-amber-500/30 shadow-none font-normal transition-colors"
                        >
                          <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                          <span>重置密码</span>
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onToggleStatus(admin)}
                          className={cn(
                            "h-7 px-2 text-xs gap-1 rounded-md border border-border/40 shadow-none font-normal transition-colors",
                            admin.status === "active"
                              ? "text-muted-foreground hover:text-amber-600 hover:bg-amber-500/10 hover:border-amber-500/30"
                              : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10 hover:border-emerald-500/30"
                          )}
                        >
                          {admin.status === "active" ? (
                            <>
                              <PowerOff className="h-3.5 w-3.5 text-amber-600" />
                              <span>禁用</span>
                            </>
                          ) : (
                            <>
                              <Power className="h-3.5 w-3.5 text-emerald-600" />
                              <span>启用</span>
                            </>
                          )}
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDeleteAdmin(admin)}
                          className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border/40 hover:border-destructive/30 shadow-none font-normal transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          <span>删除</span>
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
