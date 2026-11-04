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
  Globe,
  MonitorSmartphone,
  UserCog,
  ShieldAlert,
  Trash2,
} from "lucide-react";

interface UserTableProps {
  users: DesktopUser[];
  onEditUser: (user: DesktopUser) => void;
  onToggleStatus: (user: DesktopUser) => void;
  onResetPassword: (user: DesktopUser) => void;
  onDeleteUser: (user: DesktopUser) => void;
  onManageManagedAccount?: (user: DesktopUser) => void;
  canManageManagedAccount?: boolean;
  isLoading?: boolean;
  embedded?: boolean;
}

export function UserTable({
  users,
  onEditUser,
  onToggleStatus,
  onResetPassword,
  onDeleteUser,
  onManageManagedAccount,
  canManageManagedAccount = false,
  isLoading,
  embedded = false,
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
      <div
        className={cn(
          "flex flex-col items-center justify-center py-16 px-6 text-center",
          !embedded && "border rounded-xl bg-card shadow-sm"
        )}
      >
        <Building className="h-10 w-10 text-muted-foreground/40 mb-3" />
        <h3 className="text-sm font-medium text-foreground">暂无桌面端用户</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          未检索到符合条件的用户账号，您可以点击上方【开通桌面端账号】录入新用户
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
            <TableHead className="w-[200px]">账号与识别</TableHead>
            <TableHead>姓名 / 归属单位</TableHead>
            <TableHead className="w-[140px]">指定 VPN</TableHead>
            <TableHead className="w-[130px]">绑定管理员</TableHead>
            <TableHead className="w-[140px]">最近设备</TableHead>
            <TableHead className="w-[110px]">账号状态</TableHead>
            <TableHead className="w-[120px]">授权到期</TableHead>
            <TableHead className="w-[390px] text-right">操作管理</TableHead>
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

              {/* Assigned VPN */}
              <TableCell>
                <div className="flex flex-col text-xs">
                  <span className="flex items-center gap-1 font-medium text-foreground">
                    <Globe
                      className={cn(
                        "h-3 w-3",
                        user.proxyId && user.proxyActive === false
                          ? "text-muted-foreground"
                          : "text-success",
                      )}
                    />
                    <span className="truncate max-w-[110px]" title={user.proxyName || undefined}>
                      {user.proxyName || "默认节点"}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground mt-0.5">
                    {user.proxyId
                      ? user.proxyActive === false
                        ? "指派已失效·回落默认"
                        : "单独指派"
                      : "跟随默认"}
                  </span>
                </div>
              </TableCell>

              {/* Bound admin */}
              <TableCell>
                {user.boundAdminName ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-success/10 text-success font-medium">
                    <UserCog className="h-3 w-3" />
                    <span className="truncate max-w-[90px]" title={user.boundAdminName}>
                      {user.boundAdminName}
                    </span>
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">未绑定</span>
                )}
              </TableCell>

              {/* Last reported machine identifier */}
              <TableCell>
                {user.lastDeviceId ? (
                  <span
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground"
                    title={user.lastDeviceId}
                  >
                    <MonitorSmartphone className="h-3 w-3 shrink-0" />
                    <span className="truncate max-w-[110px]">
                      {user.lastDeviceId.length > 14
                        ? `…${user.lastDeviceId.slice(-10)}`
                        : user.lastDeviceId}
                    </span>
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">未上报</span>
                )}
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
                    variant="table-action"
                    size="xs"
                    onClick={() => onEditUser(user)}
                  >
                    <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>编辑</span>
                  </Button>

                  <Button
                    variant="table-action"
                    size="xs"
                    onClick={() => onResetPassword(user)}
                    className="hover:text-warning dark:hover:text-warning hover:bg-warning/10 hover:border-warning/30"
                  >
                    <KeyRound className="h-3.5 w-3.5 text-warning" />
                    <span>重置密码</span>
                  </Button>

                  <Button
                    variant="table-action"
                    size="xs"
                    onClick={() => onToggleStatus(user)}
                    className={
                      user.status === "active"
                        ? "hover:text-warning dark:hover:text-warning hover:bg-warning/10 hover:border-warning/30"
                        : "hover:text-success dark:hover:text-success hover:bg-success/10 hover:border-success/30"
                    }
                  >
                    {user.status === "active" ? (
                      <>
                        <PowerOff className="h-3.5 w-3.5 text-warning" />
                        <span>停用</span>
                      </>
                    ) : (
                      <>
                        <Power className="h-3.5 w-3.5 text-success" />
                        <span>启用</span>
                      </>
                    )}
                  </Button>

                  {canManageManagedAccount && onManageManagedAccount && (
                    <Button
                      variant="table-action"
                      size="xs"
                      onClick={() => onManageManagedAccount(user)}
                      className="hover:text-primary hover:bg-primary/10 hover:border-primary/30"
                    >
                      <KeyRound className="h-3.5 w-3.5 text-primary" />
                      <span>绑定托管账号</span>
                    </Button>
                  )}

                  <Button
                    variant="table-action"
                    size="xs"
                    onClick={() => onDeleteUser(user)}
                    className="hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
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
