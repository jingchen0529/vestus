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
  embedded?: boolean;
}

export function AdminTable({
  admins,
  onEditAdmin,
  onToggleStatus,
  onResetPassword,
  onDeleteAdmin,
  isLoading,
  embedded = false,
}: AdminTableProps) {
  const { user: currentLoggedAdmin } = useAuth();

  if (admins.length === 0 && !isLoading) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center py-16 px-6 text-center",
          !embedded && "border rounded-xl bg-card shadow-sm"
        )}
      >
        <ShieldCheck className="h-10 w-10 text-muted-foreground/40 mb-3" />
        <h3 className="text-sm font-medium text-foreground">暂无符合条件的管理员</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          请尝试调整搜索关键词或点击上方【新增管理员】开通管理账号
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "overflow-x-auto",
        !embedded && "rounded-xl border bg-card shadow-sm overflow-hidden"
      )}
    >
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
                      variant="table-action"
                      size="xs"
                      onClick={() => onEditAdmin(admin)}
                    >
                      <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>编辑</span>
                    </Button>

                    {!isSelf && (
                      <>
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => onResetPassword(admin)}
                          className="hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/30"
                        >
                          <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                          <span>重置密码</span>
                        </Button>

                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => onToggleStatus(admin)}
                          className={
                            admin.status === "active"
                              ? "hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/30"
                              : "hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/30"
                          }
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
                          variant="table-action"
                          size="xs"
                          onClick={() => onDeleteAdmin(admin)}
                          className="hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
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
