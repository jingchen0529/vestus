import { useState } from "react";
import { UserTable } from "./user-table";
import { UserDialog } from "./user-dialog";
import { UserResetPasswordDialog } from "./user-reset-password-dialog";
import { DesktopUser, CreateUserPayload, UpdateUserPayload } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { AdminUser } from "@/types/admin";
import {
  CreateUserManagedAccountPayload,
  ManagedIdentityCheckResponse,
  ManagedPlatformAccount,
  UpdateUserManagedAccountPayload,
  UserManagedAccountBinding,
  UserManagedPlatformAccount,
  UserManagedPlatformAccountPayload,
} from "@/types/managed-platform";
import { ManagedAccountDialog } from "./managed-account-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DataCard,
  PageToolbar,
  PageToolbarActions,
  PageToolbarFilters,
  ToolbarSearch,
} from "@/components/ui/page-toolbar";
import { Plus, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
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
  /** 超管可用：供弹窗选择 VPN 节点与绑定管理员。 */
  proxies?: ProxyItem[];
  admins?: AdminUser[];
  canAssignVpn?: boolean;
  canManageManagedAccount?: boolean;
  /** 方舟平台 URL 推导的 Cookie 默认 domain，供托管账号弹窗粘贴原始 Cookie 字符串用。 */
  cookieDefaultDomain?: string;
  onGetManagedAccount?: (userId: number) => Promise<UserManagedPlatformAccount | null>;
  onSaveManagedAccount?: (userId: number, payload: UserManagedPlatformAccountPayload) => Promise<void>;
  onDeleteManagedAccount?: (userId: number) => Promise<void>;
  availableManagedAccounts?: ManagedPlatformAccount[];
  onGetManagedAccounts?: (userId: number) => Promise<UserManagedAccountBinding[]>;
  onBindManagedAccount?: (userId: number, managedAccountId: number) => Promise<void>;
  onUnbindManagedAccount?: (userId: number, managedAccountId: number) => Promise<void>;
  onCreateManagedAccount?: (
    userId: number,
    payload: CreateUserManagedAccountPayload,
  ) => Promise<void>;
  onGetManagedAccountDetail?: (
    userId: number,
    managedAccountId: number,
  ) => Promise<UserManagedPlatformAccount>;
  onUpdateManagedAccount?: (
    userId: number,
    managedAccountId: number,
    payload: UpdateUserManagedAccountPayload,
  ) => Promise<void>;
  onCheckIdentity?: (managedAccountId: number) => Promise<ManagedIdentityCheckResponse>;
}

export function UsersView({
  users,
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
  proxies,
  admins,
  canAssignVpn,
  canManageManagedAccount = false,
  cookieDefaultDomain,
  onGetManagedAccount,
  onSaveManagedAccount,
  onDeleteManagedAccount,
  availableManagedAccounts = [],
  onGetManagedAccounts,
  onBindManagedAccount,
  onUnbindManagedAccount,
  onCreateManagedAccount,
  onGetManagedAccountDetail,
  onUpdateManagedAccount,
  onCheckIdentity,
}: UsersViewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<DesktopUser | null>(null);

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetUser, setResetUser] = useState<DesktopUser | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<DesktopUser | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [managedDialogOpen, setManagedDialogOpen] = useState(false);
  const [managedUser, setManagedUser] = useState<DesktopUser | null>(null);
  const [managedAccount, setManagedAccount] = useState<UserManagedPlatformAccount | null>(null);
  const [managedBindings, setManagedBindings] = useState<UserManagedAccountBinding[]>([]);
  const [managedAccountLoading, setManagedAccountLoading] = useState(false);

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

  const handleOpenManagedAccount = async (user: DesktopUser) => {
    if (!canManageManagedAccount || (!onGetManagedAccounts && !onGetManagedAccount)) return;
    setManagedUser(user);
    setManagedAccount(null);
    setManagedBindings([]);
    setManagedDialogOpen(true);
    setManagedAccountLoading(true);
    try {
      if (onGetManagedAccounts) {
        setManagedBindings(await onGetManagedAccounts(user.id));
      } else if (onGetManagedAccount) {
        setManagedAccount(await onGetManagedAccount(user.id));
      }
    } catch (error) {
      toast.error("读取托管账号失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setManagedAccountLoading(false);
    }
  };

  const refreshManagedBindingsForUser = async (userId: number) => {
    if (onGetManagedAccounts && managedUser?.id === userId) {
      setManagedBindings(await onGetManagedAccounts(userId));
    }
  };

  const handleBindManagedAccount = async (userId: number, managedAccountId: number) => {
    if (!onBindManagedAccount) return;
    await onBindManagedAccount(userId, managedAccountId);
    await refreshManagedBindingsForUser(userId);
  };

  const handleUnbindManagedAccount = async (userId: number, managedAccountId: number) => {
    if (!onUnbindManagedAccount) return;
    await onUnbindManagedAccount(userId, managedAccountId);
    await refreshManagedBindingsForUser(userId);
  };

  /** 检查登录态后刷新弹窗内的绑定列表，使身份/会话状态立即生效。 */
  const handleCheckManagedIdentity = async (managedAccountId: number) => {
    if (!onCheckIdentity || !managedUser) {
      throw new Error("当前登录身份无法检查登录态");
    }
    const result = await onCheckIdentity(managedAccountId);
    await refreshManagedBindingsForUser(managedUser.id);
    return result;
  };

  const handleCreateUserManagedAccount = async (
    userId: number,
    payload: CreateUserManagedAccountPayload,
  ) => {
    if (!onCreateManagedAccount) return;
    await onCreateManagedAccount(userId, payload);
    await refreshManagedBindingsForUser(userId);
  };

  const handleUpdateUserManagedAccount = async (
    userId: number,
    managedAccountId: number,
    payload: UpdateUserManagedAccountPayload,
  ) => {
    if (!onUpdateManagedAccount) return;
    await onUpdateManagedAccount(userId, managedAccountId, payload);
    await refreshManagedBindingsForUser(userId);
  };

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-300">
      <DataCard>
        <PageToolbar>
          <PageToolbarActions>
            <Button size="sm" onClick={handleOpenCreate}>
              <Plus className="h-3.5 w-3.5" />
              <span>开通桌面端账号</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`}
              />
              <span>刷新</span>
            </Button>
          </PageToolbarActions>

          <PageToolbarFilters>
            <ToolbarSearch
              value={search}
              onChange={onSearchChange}
              placeholder="搜索账号、姓名或所属企业..."
            />

            <div className="w-36 shrink-0">
              <Select value={statusFilter} onValueChange={onStatusFilterChange}>
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部状态</SelectItem>
                  <SelectItem value="active" className="text-xs">正常启用</SelectItem>
                  <SelectItem value="disabled" className="text-xs">已禁用</SelectItem>
                  <SelectItem value="locked" className="text-xs">已锁定</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PageToolbarFilters>
        </PageToolbar>

        <UserTable
          users={users}
          onEditUser={handleOpenEdit}
          onToggleStatus={onToggleUserStatus}
          onResetPassword={handleOpenReset}
          onDeleteUser={handleOpenDelete}
          onManageManagedAccount={handleOpenManagedAccount}
          canManageManagedAccount={canManageManagedAccount}
          isLoading={isRefreshing}
          embedded
        />
      </DataCard>

      {/* Modals */}
      <UserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        userToEdit={editingUser}
        onSubmitCreate={onCreateUser}
        onSubmitUpdate={onUpdateUser}
        proxies={proxies}
        admins={admins}
        canAssignVpn={canAssignVpn}
      />

      <UserResetPasswordDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        user={resetUser}
        onSubmitReset={onResetPassword}
      />

      {canManageManagedAccount && (onCreateManagedAccount || onSaveManagedAccount) && (
        <ManagedAccountDialog
          open={managedDialogOpen}
          onOpenChange={(open) => {
            setManagedDialogOpen(open);
            if (!open) {
              setManagedUser(null);
              setManagedAccount(null);
              setManagedBindings([]);
            }
          }}
          user={managedUser}
          account={managedAccount}
          bindings={managedBindings}
          availableAccounts={availableManagedAccounts}
          accountLoading={managedAccountLoading}
          cookieDefaultDomain={cookieDefaultDomain}
          onSave={onSaveManagedAccount}
          onDelete={onDeleteManagedAccount}
          onBind={onBindManagedAccount ? handleBindManagedAccount : undefined}
          onUnbind={onUnbindManagedAccount ? handleUnbindManagedAccount : undefined}
          onCreateAccount={onCreateManagedAccount ? handleCreateUserManagedAccount : undefined}
          onGetAccountDetail={onGetManagedAccountDetail}
          onUpdateAccount={onUpdateManagedAccount ? handleUpdateUserManagedAccount : undefined}
          onCheckIdentity={onCheckIdentity ? handleCheckManagedIdentity : undefined}
        />
      )}

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
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleConfirmDelete}
              loading={isDeleting}
              className="font-semibold"
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
