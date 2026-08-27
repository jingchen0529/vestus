import { useState } from "react";
import { AdminTable } from "./admin-table";
import { AdminDialog } from "./admin-dialog";
import { AdminResetPasswordDialog } from "./admin-reset-password-dialog";
import { AdminUser, CreateAdminPayload, UpdateAdminPayload } from "@/types/admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldCheck, UserPlus, Search, RefreshCw, AlertTriangle, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface AdminsViewProps {
  admins: AdminUser[];
  search: string;
  onSearchChange: (val: string) => void;
  statusFilter: string;
  onStatusFilterChange: (val: string) => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  onCreateAdmin: (payload: CreateAdminPayload) => Promise<void>;
  onUpdateAdmin: (id: number, payload: UpdateAdminPayload) => Promise<void>;
  onToggleAdminStatus: (admin: AdminUser) => Promise<void>;
  onResetPassword: (id: number, pwd: string) => Promise<void>;
  onDeleteAdmin: (admin: AdminUser) => Promise<void>;
}

export function AdminsView({
  admins,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  onRefresh,
  isRefreshing,
  onCreateAdmin,
  onUpdateAdmin,
  onToggleAdminStatus,
  onResetPassword,
  onDeleteAdmin,
}: AdminsViewProps) {
  const { isSuperAdmin } = useAuth();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<AdminUser | null>(null);

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetAdmin, setResetAdmin] = useState<AdminUser | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [adminToDelete, setAdminToDelete] = useState<AdminUser | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleOpenCreate = () => {
    setEditingAdmin(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (admin: AdminUser) => {
    setEditingAdmin(admin);
    setDialogOpen(true);
  };

  const handleOpenReset = (admin: AdminUser) => {
    setResetAdmin(admin);
    setResetDialogOpen(true);
  };

  const handleOpenDelete = (admin: AdminUser) => {
    setAdminToDelete(admin);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!adminToDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteAdmin(adminToDelete);
      setDeleteDialogOpen(false);
      setAdminToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  if (!isSuperAdmin) {
    return (
      <Card className="border-border/80 p-8 text-center bg-card">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <h3 className="text-base font-bold text-foreground">
          权限受限：仅超级管理员可访问
        </h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          系统管理员管理模块涉及底层核心权限分配与安全策略，当前账号角色为普通管理员，无法进行操作。
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in-50 duration-300">
      {/* Super Admin Notice */}
      <div className="flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-primary">
        <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
        <span>超级管理员控制台：您拥有全部管理成员账号开通、角色委派及密码重置权限。</span>
      </div>

      {/* Toolbar */}
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
                <span>新增管理员</span>
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
                  placeholder="搜索管理员账号或姓名..."
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
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Admin Table */}
      <AdminTable
        admins={admins}
        onEditAdmin={handleOpenEdit}
        onToggleStatus={onToggleAdminStatus}
        onResetPassword={handleOpenReset}
        onDeleteAdmin={handleOpenDelete}
        isLoading={isRefreshing}
      />

      {/* Admin Dialog */}
      <AdminDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        adminToEdit={editingAdmin}
        onSubmitCreate={onCreateAdmin}
        onSubmitUpdate={onUpdateAdmin}
      />

      {/* Reset Password Dialog */}
      <AdminResetPasswordDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        admin={resetAdmin}
        onSubmitReset={onResetPassword}
      />

      {/* Delete Admin Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive mb-1">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <DialogTitle className="text-base font-bold">确认删除管理员账号？</DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground pt-1.5 leading-relaxed">
              您确定要删除管理员账号{" "}
              <strong className="text-foreground font-semibold font-mono">
                {adminToDelete?.username}
              </strong>
              {adminToDelete?.name ? `（${adminToDelete.name}）` : ""}吗？
              <br />
              删除后该管理员将立即失去后台登录与操作权限。
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
