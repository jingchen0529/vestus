import { useState } from "react";
import { UserTable } from "./user-table";
import { UserDialog } from "./user-dialog";
import { UserResetPasswordDialog } from "./user-reset-password-dialog";
import { DesktopUser, CreateUserPayload, UpdateUserPayload, UserStats } from "@/types/user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, Search, RefreshCw, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface UsersViewProps {
  users: DesktopUser[];
  userStats?: UserStats | null;
  search: string;
  onSearchChange: (val: string) => void;
  statusFilter: string;
  onStatusFilterChange: (val: string) => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  onCreateUser: (payload: CreateUserPayload) => Promise<void>;
  onUpdateUser: (id: number, payload: UpdateUserPayload) => Promise<void>;
  onToggleUserStatus: (user: DesktopUser) => Promise<void>;
  onResetPassword: (id: number, pwd: string) => Promise<void>;
  onDeleteUser: (user: DesktopUser) => Promise<void>;
}

export function UsersView({
  users,
  userStats,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  onRefresh,
  isRefreshing,
  onCreateUser,
  onUpdateUser,
  onToggleUserStatus,
  onResetPassword,
  onDeleteUser,
}: UsersViewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<DesktopUser | null>(null);

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetUser, setResetUser] = useState<DesktopUser | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<DesktopUser | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleOpenCreate = () => {
    setEditingUser(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (user: DesktopUser) => {
    setEditingUser(user);
    setDialogOpen(true);
  };

  const handleOpenReset = (user: DesktopUser) => {
    setResetUser(user);
    setResetDialogOpen(true);
  };

  const handleOpenDelete = (user: DesktopUser) => {
    setUserToDelete(user);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!userToDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteUser(userToDelete);
      setDeleteDialogOpen(false);
      setUserToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in-50 duration-300">
      {/* Top Action & Filter Toolbar */}
      <Card className="border-border/80 shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            {/* Action Buttons on Left */}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                onClick={handleOpenCreate}
                size="sm"
                className="h-9 gap-1.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm font-semibold"
              >
                <UserPlus className="h-4 w-4" />
                <span>开通桌面端账号</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isRefreshing}
                className="h-9 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                <span>刷新</span>
              </Button>
            </div>

            {/* Search and Filters on Right */}
            <div className="flex flex-1 items-center justify-end gap-2.5">
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索账号、姓名或所属企业..."
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  className="pl-9 h-9 text-xs"
                />
              </div>

              <div className="w-36 shrink-0">
                <Select
                  value={statusFilter}
                  onValueChange={onStatusFilterChange}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="全部状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部状态</SelectItem>
                    <SelectItem value="active">正常启用</SelectItem>
                    <SelectItem value="disabled">已禁用</SelectItem>
                    <SelectItem value="locked">已锁定</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Stats Bar */}
          {userStats && (
            <div className="mt-3 pt-3 border-t flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-4">
                <span>
                  共 <strong className="text-foreground">{userStats.total}</strong> 个受权账号
                </span>
                <span>
                  正常: <strong className="text-emerald-600 dark:text-emerald-400">{userStats.active}</strong>
                </span>
                <span>
                  已禁用: <strong className="text-foreground">{userStats.disabled}</strong>
                </span>
                {userStats.locked > 0 && (
                  <span>
                    锁定: <strong className="text-amber-500">{userStats.locked}</strong>
                  </span>
                )}
              </div>
              <div className="text-[11px]">
                当前列表匹配: {users.length} 条记录
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Users Table */}
      <UserTable
        users={users}
        onEditUser={handleOpenEdit}
        onToggleStatus={onToggleUserStatus}
        onResetPassword={handleOpenReset}
        onDeleteUser={handleOpenDelete}
        isLoading={isRefreshing}
      />

      {/* Modals */}
      <UserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        userToEdit={editingUser}
        onSubmitCreate={onCreateUser}
        onSubmitUpdate={onUpdateUser}
      />

      <UserResetPasswordDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        user={resetUser}
        onSubmitReset={onResetPassword}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive mb-1">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <DialogTitle className="text-base font-bold">确认删除用户账号？</DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground pt-1.5 leading-relaxed">
              您确定要删除桌面端用户账号{" "}
              <strong className="text-foreground font-semibold font-mono">
                {userToDelete?.username}
              </strong>
              {userToDelete?.name ? `（${userToDelete.name}）` : ""}吗？
              <br />
              删除后该用户将立即无法登录桌面端系统，其桌面环境与平台授权也将被注销。
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-0 mt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isDeleting}
              className="text-xs"
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="text-xs gap-1.5 font-semibold"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>正在删除...</span>
                </>
              ) : (
                <span>确认删除</span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
