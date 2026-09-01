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
import { cn } from "@/lib/utils";
import { DesktopUser } from "@/types/user";
import {
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
            <TableHead className="w-[280px] text-right">操作管理</TableHead>
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
              <TableCell className="text-right whitespace-nowrap">
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEditUser(user)}
                    className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70 border border-border/40 hover:border-border/70 shadow-none font-normal transition-colors"
                  >
                    <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>编辑</span>
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onResetPassword(user)}
                    className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 border border-border/40 hover:border-amber-500/30 shadow-none font-normal transition-colors"
                  >
                    <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                    <span>重置密码</span>
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggleStatus(user)}
                    className={cn(
                      "h-7 px-2 text-xs gap-1 rounded-md border border-border/40 shadow-none font-normal transition-colors",
                      user.status === "active"
                        ? "text-muted-foreground hover:text-amber-600 hover:bg-amber-500/10 hover:border-amber-500/30"
                        : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10 hover:border-emerald-500/30"
                    )}
                  >
                    {user.status === "active" ? (
                      <>
                        <PowerOff className="h-3.5 w-3.5 text-amber-600" />
                        <span>停用</span>
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
                    onClick={() => onDeleteUser(user)}
                    className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border/40 hover:border-destructive/30 shadow-none font-normal transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    <span>删除</span>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
