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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DesktopUser } from "@/types/user";
import {
  MoreHorizontal,
  Edit2,
  KeyRound,
  PowerOff,
  Power,
  Building,
  Phone,
  Clock,
  ShieldAlert,
  Trash2,
} from "lucide-react";

interface UserTableProps {
  users: DesktopUser[];
  onEditUser: (user: DesktopUser) => void;
  onToggleStatus: (user: DesktopUser) => void;
  onResetPassword: (user: DesktopUser) => void;
  onDeleteUser: (user: DesktopUser) => void;
  isLoading?: boolean;
}

export function UserTable({
  users,
  onEditUser,
  onToggleStatus,
  onResetPassword,
  onDeleteUser,
  isLoading,
}: UserTableProps) {
  const isExpired = (expiresAt?: string | null) => {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() < Date.now();
  };

  const getStatusBadge = (user: DesktopUser) => {
    if (user.status === "locked") {
      return (
        <Badge variant="warning" className="gap-1">
          <ShieldAlert className="h-3 w-3" />
          <span>已锁定</span>
        </Badge>
      );
    }
    if (user.status === "disabled") {
      return <Badge variant="secondary">已禁用</Badge>;
    }
    if (isExpired(user.expiresAt)) {
      return <Badge variant="destructive">已过期</Badge>;
    }
    return <Badge variant="success">正常启用</Badge>;
  };

  if (users.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border rounded-xl bg-card">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground mb-3">
          <Building className="h-6 w-6" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">暂无桌面端用户</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          未检索到符合条件的用户账号，您可以点击上方按钮开通新用户
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[220px]">账号与识别</TableHead>
            <TableHead>姓名 / 归属单位</TableHead>
            <TableHead className="w-[120px]">账号状态</TableHead>
            <TableHead className="w-[140px]">授权到期</TableHead>
            <TableHead className="w-[160px] text-right">操作管理</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id} className="hover:bg-muted/40 transition-colors">
              {/* Username & ID */}
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-bold text-foreground text-sm tracking-tight">
                    {user.username}
                  </span>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                    <span>#{user.id}</span>
                    {user.remark && (
                      <span className="truncate max-w-[120px]" title={user.remark}>
                        · {user.remark}
                      </span>
                    )}
                  </div>
                </div>
              </TableCell>

              {/* Name, Company, Phone */}
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-medium text-foreground text-sm">
                    {user.name}
                  </span>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5">
                    {user.company && (
                      <span className="flex items-center gap-1">
                        <Building className="h-3 w-3" />
                        <span className="truncate max-w-[120px]">{user.company}</span>
                      </span>
                    )}
                    {user.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        <span>{user.phone}</span>
                      </span>
                    )}
                  </div>
                </div>
              </TableCell>

              {/* Status */}
              <TableCell>{getStatusBadge(user)}</TableCell>

              {/* Expiry */}
              <TableCell>
                <div className="flex items-center gap-1.5 text-xs">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className={isExpired(user.expiresAt) ? "text-destructive font-medium" : "text-foreground"}>
                    {user.expiresAt ? user.expiresAt.substring(0, 10) : "永久有效"}
                  </span>
                </div>
              </TableCell>

              {/* Actions */}
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    variant={user.status === "active" ? "outline" : "secondary"}
                    size="sm"
                    onClick={() => onToggleStatus(user)}
                    className="h-8 px-2 text-xs"
                  >
                    {user.status === "active" ? (
                      <span className="text-destructive hover:underline">停用</span>
                    ) : (
                      <span className="text-emerald-600 font-medium">启用</span>
                    )}
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">更多操作</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onClick={() => onEditUser(user)}
                        className="gap-2 text-xs cursor-pointer"
                      >
                        <Edit2 className="h-3.5 w-3.5 text-blue-500" />
                        <span>编辑资料</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onResetPassword(user)}
                        className="gap-2 text-xs cursor-pointer"
                      >
                        <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                        <span>重置密码</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => onToggleStatus(user)}
                        className="gap-2 text-xs cursor-pointer"
                      >
                        {user.status === "active" ? (
                          <>
                            <PowerOff className="h-3.5 w-3.5 text-amber-600" />
                            <span className="text-amber-600">停用此账号</span>
                          </>
                        ) : (
                          <>
                            <Power className="h-3.5 w-3.5 text-emerald-600" />
                            <span className="text-emerald-600">启用此账号</span>
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => onDeleteUser(user)}
                        className="gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer font-medium"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>删除此账号</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
