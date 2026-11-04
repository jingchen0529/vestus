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
  MoreHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
            <TableHead className="w-[96px] text-right">操作</TableHead>
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
                    <Badge variant="secondary" className="gap-1 text-[10px] font-normal text-muted-foreground">
                      <UserCheck className="h-3 w-3" />
                      <span>普通管理员</span>
                    </Badge>
                  )}
                </TableCell>

                {/* Status */}
                <TableCell>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-[11px] font-medium",
                      admin.status === "active" ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    <i
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        admin.status === "active" ? "bg-success" : "bg-muted-foreground/50",
                      )}
                    />
                    {admin.status === "active" ? "正常" : "已禁用"}
                  </span>
                </TableCell>

                {/* Last Login */}
                <TableCell>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0" />
                    <span className="tabular-nums">{formatDate(admin.lastLoginAt)}</span>
                  </div>
                </TableCell>

                {/* Actions：一个主操作 + 一个更多菜单，避免每行四颗彩色按钮 */}
                <TableCell className="text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => onEditAdmin(admin)}
                      className="h-7 gap-1 px-2 text-[11px] font-medium text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                      <span>编辑</span>
                    </Button>

                    {!isSelf && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground"
                            aria-label="更多操作"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40 p-1">
                          <DropdownMenuItem
                            onClick={() => onResetPassword(admin)}
                            className="gap-2 text-xs"
                          >
                            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>重置密码</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onToggleStatus(admin)}
                            className="gap-2 text-xs"
                          >
                            {admin.status === "active" ? (
                              <>
                                <PowerOff className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>禁用账号</span>
                              </>
                            ) : (
                              <>
                                <Power className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>启用账号</span>
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDeleteAdmin(admin)}
                            className="gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>删除管理员</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
