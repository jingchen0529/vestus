import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DesktopUser } from "@/types/user";
import {
  CreateUserManagedAccountPayload,
  ManagedAccountStatus,
  ManagedAuthMode,
  ManagedIdentityCheckResponse,
  ManagedPlatformAccount,
  UpdateUserManagedAccountPayload,
  UserManagedAccountBinding,
  UserManagedAuthMode,
  UserManagedPlatformAccount,
  UserManagedPlatformAccountPayload,
} from "@/types/managed-platform";
import { parseCookieInput } from "@/lib/cookie-parser";
import { isManagedRecovering, managedRecoveryLabel } from "@/lib/managed-recovery";
import {
  ClipboardPaste,
  Edit2,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

export interface ManagedAccountFormValues {
  name?: string;
  authMode: UserManagedAuthMode;
  username: string;
  password: string;
  cookieJson: string;
}

export function buildManagedAccountPayload(
  values: ManagedAccountFormValues,
  cookieDefaultDomain?: string,
): CreateUserManagedAccountPayload {
  const payload: CreateUserManagedAccountPayload = {
    authMode: values.authMode,
  };
  if (values.name && values.name.trim()) {
    payload.name = values.name.trim();
  }
  if (values.authMode === "server_login") {
    payload.autoRelogin = true;
    if (values.username.trim()) payload.username = values.username.trim();
    if (values.password) payload.password = values.password;
  } else if (values.cookieJson.trim()) {
    payload.cookieBundle = parseCookieInput(values.cookieJson.trim(), cookieDefaultDomain);
  }
  return payload;
}

const AUTH_MODE_LABELS: Record<ManagedAuthMode, string> = {
  cookie: "Cookie",
  server_login: "账号密码",
  official_sso: "官方授权",
};

function renderBindingStatusBadge(status: ManagedAccountStatus | "active") {
  switch (status) {
    case "active":
      return <Badge variant="success">正常启用</Badge>;
    case "expired":
      return <Badge variant="warning">已过期</Badge>;
    case "invalid":
      return <Badge variant="destructive">需处理</Badge>;
    case "revoked":
      return <Badge variant="secondary">已撤销</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export interface ManagedAccountBindingListProps {
  bindings: UserManagedAccountBinding[];
  availableAccounts?: ManagedPlatformAccount[];
  onEdit?: (binding: UserManagedAccountBinding) => void;
  onUnbind?: (binding: UserManagedAccountBinding) => void;
  onCheckIdentity?: (managedAccountId: number) => Promise<ManagedIdentityCheckResponse>;
  busyAccountId?: number | null;
  disabled?: boolean;
}

export function ManagedAccountBindingList({
  bindings,
  availableAccounts = [],
  onEdit,
  onUnbind,
  onCheckIdentity,
  busyAccountId = null,
  disabled = false,
}: ManagedAccountBindingListProps) {
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const accountMap = useMemo(
    () => new Map(availableAccounts.map((acc) => [acc.id, acc])),
    [availableAccounts],
  );
  const showActions = Boolean(onEdit || onUnbind || onCheckIdentity);

  const handleCheckIdentity = async (item: UserManagedAccountBinding) => {
    if (!onCheckIdentity) return;
    setCheckingId(item.managedAccountId);
    try {
      const result = await onCheckIdentity(item.managedAccountId);
      if (result.state === "verified") {
        toast.success(`登录态有效：${result.account.remoteDisplayName || "身份已刷新"}`);
      } else {
        toast.error("登录态已失效，会话已标记过期", {
          description: result.detail || "上游返回未登录，请替换 Cookie",
        });
      }
    } catch (error) {
      toast.error("检查登录态失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setCheckingId(null);
    }
  };

  if (bindings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 text-center text-muted-foreground">
        <KeyRound className="mb-3 h-10 w-10 text-muted-foreground/35" />
        <p className="text-sm font-medium text-foreground">暂未绑定托管账号</p>
        <p className="mt-1 text-xs text-muted-foreground">
          点击左上角「新增托管账号」直接录入凭据，或从账号库选择已有账号绑定
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead className="w-[72px] text-center">ID</TableHead>
            <TableHead>托管账号</TableHead>
            <TableHead>所属平台</TableHead>
            <TableHead>认证方式</TableHead>
            <TableHead>状态</TableHead>
            {showActions && <TableHead className="text-right pr-4">操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {bindings.map((item) => {
            const poolAccount = accountMap.get(item.managedAccountId);
            const resolvedAuthMode = item.authMode || poolAccount?.authMode;
            const resolvedAlias = item.alias || poolAccount?.name;
            const isRowBusy = disabled || busyAccountId === item.managedAccountId;

            return (
              <TableRow
                key={item.managedAccountId}
                className="hover:bg-muted/40 transition-colors text-xs"
              >
                <TableCell className="py-3 text-center font-mono text-muted-foreground">
                  #{item.managedAccountId}
                </TableCell>
                <TableCell className="py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                      <KeyRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground truncate">
                        {item.name}
                      </div>
                      {item.remoteDisplayName && item.remoteDisplayName !== item.name ? (
                        <div
                          className="text-[11px] text-muted-foreground truncate"
                          title={`平台身份：${item.remoteDisplayName}`}
                        >
                          {item.remoteDisplayName}
                        </div>
                      ) : null}
                      <div className="text-[11px] text-muted-foreground font-mono truncate">
                        {resolvedAlias && resolvedAlias !== item.name
                          ? `别名: ${resolvedAlias}`
                          : item.credentialVersion
                            ? `凭据 v${item.credentialVersion}`
                            : "密钥已托管，不回显"}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="py-3 whitespace-nowrap font-medium text-foreground">
                  {item.platformName || `平台 #${item.platformId}`}
                </TableCell>
                <TableCell className="py-3 whitespace-nowrap">
                  <Badge variant="outline" className="text-[11px] font-normal">
                    {resolvedAuthMode
                      ? AUTH_MODE_LABELS[resolvedAuthMode] || resolvedAuthMode
                      : "已托管"}
                  </Badge>
                </TableCell>
                <TableCell className="py-3 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    {renderBindingStatusBadge(item.status)}
                    {isManagedRecovering(item) ? (
                      <Badge variant="warning" className="gap-1 text-[10px]" title={item.lastError || undefined}>
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        {managedRecoveryLabel(item)}
                      </Badge>
                    ) : item.recoveryStatus === "failed" ? (
                      <Badge variant="destructive" className="text-[10px]" title={item.lastError || undefined}>
                        自动恢复失败
                      </Badge>
                    ) : item.sessionStatus === "expired" ? (
                      <Badge variant="destructive" className="gap-1 text-[10px]" title={item.lastError || undefined}>
                        <ShieldAlert className="h-3 w-3" />
                        会话已失效
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                {showActions && (
                  <TableCell className="py-3 pr-4 text-right whitespace-nowrap">
                    <div className="flex justify-end gap-1.5">
                      {onCheckIdentity && resolvedAuthMode !== "official_sso" && (
                        <Button
                          type="button"
                          variant="table-action"
                          size="xs"
                          onClick={() => void handleCheckIdentity(item)}
                          disabled={isRowBusy || checkingId === item.managedAccountId}
                        >
                          <ShieldCheck
                            className={`h-3.5 w-3.5 text-primary ${checkingId === item.managedAccountId ? "animate-pulse" : ""}`}
                          />
                          <span>
                            {checkingId === item.managedAccountId ? "检查中…" : "检查登录态"}
                          </span>
                        </Button>
                      )}
                      {onEdit && (
                        <Button
                          type="button"
                          variant="table-action"
                          size="xs"
                          onClick={() => onEdit(item)}
                          disabled={isRowBusy}
                        >
                          <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>编辑</span>
                        </Button>
                      )}
                      {onUnbind && (
                        <Button
                          type="button"
                          variant="table-action"
                          size="xs"
                          onClick={() => onUnbind(item)}
                          disabled={isRowBusy}
                          className="hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          <span>解除</span>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

interface ManagedAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: DesktopUser | null;
  account?: UserManagedPlatformAccount | null;
  accountLoading?: boolean;
  /** 由方舟平台 URL 推导的 Cookie 默认 domain；粘贴浏览器原始 Cookie 字符串时必需。 */
  cookieDefaultDomain?: string;
  onSave?: (userId: number, payload: UserManagedPlatformAccountPayload) => Promise<void>;
  onDelete?: (userId: number) => Promise<void>;
  bindings?: UserManagedAccountBinding[];
  availableAccounts?: ManagedPlatformAccount[];
  onBind?: (userId: number, managedAccountId: number) => Promise<void>;
  onUnbind?: (userId: number, managedAccountId: number) => Promise<void>;
  onCreateAccount?: (
    userId: number,
    payload: CreateUserManagedAccountPayload,
  ) => Promise<void>;
  onGetAccountDetail?: (
    userId: number,
    managedAccountId: number,
  ) => Promise<UserManagedPlatformAccount>;
  onUpdateAccount?: (
    userId: number,
    managedAccountId: number,
    payload: UpdateUserManagedAccountPayload,
  ) => Promise<void>;
  onCheckIdentity?: (managedAccountId: number) => Promise<ManagedIdentityCheckResponse>;
}

type FormMode = "create" | "edit";

function suggestAccountName(
  user: DesktopUser | null,
  bindings: UserManagedAccountBinding[],
  availableAccounts: ManagedPlatformAccount[],
): string {
  const prefix = user?.username || (user ? `user-${user.id}` : "ark");
  const taken = new Set<string>([
    ...bindings.map((b) => b.alias || b.name),
    ...availableAccounts.map((a) => a.name),
  ]);
  const first = `${prefix}-ark`;
  if (!taken.has(first)) return first;
  let idx = 2;
  while (taken.has(`${first}-${idx}`)) {
    idx += 1;
  }
  return `${first}-${idx}`;
}

export function ManagedAccountDialog({
  open,
  onOpenChange,
  user,
  account = null,
  accountLoading = false,
  cookieDefaultDomain,
  onSave,
  bindings = [],
  availableAccounts = [],
  onBind,
  onUnbind,
  onCreateAccount,
  onGetAccountDetail,
  onUpdateAccount,
  onCheckIdentity,
}: ManagedAccountDialogProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("create");
  const [editingBinding, setEditingBinding] = useState<UserManagedAccountBinding | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [accountName, setAccountName] = useState("");
  const [authMode, setAuthMode] = useState<UserManagedAuthMode>("cookie");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [cookieJson, setCookieJson] = useState("");

  const [saving, setSaving] = useState(false);
  const [bindingId, setBindingId] = useState<number | null>(null);
  const [selectedPoolId, setSelectedPoolId] = useState("");

  useEffect(() => {
    if (!open) {
      setFormOpen(false);
      setEditingBinding(null);
      setDetailLoading(false);
      setSelectedPoolId("");
    }
  }, [open, user?.id]);

  const boundIds = useMemo(
    () => new Set(bindings.map((item) => item.managedAccountId)),
    [bindings],
  );

  const unboundAccounts = useMemo(
    () =>
      availableAccounts.filter(
        (item) => item.status !== "revoked" && !boundIds.has(item.id),
      ),
    [availableAccounts, boundIds],
  );

  useEffect(() => {
    if (selectedPoolId && !unboundAccounts.some((acc) => String(acc.id) === selectedPoolId)) {
      setSelectedPoolId("");
    }
  }, [selectedPoolId, unboundAccounts]);

  const listBusy = saving || accountLoading || bindingId !== null;
  const formBusy = saving || detailLoading;
  const canEdit = Boolean(onUpdateAccount || onSave);

  const handleCloseForm = () => {
    if (saving) return;
    setFormOpen(false);
    setEditingBinding(null);
    setDetailLoading(false);
  };

  const handleStartCreate = () => {
    setEditingBinding(null);
    setFormMode("create");
    setAccountName(suggestAccountName(user, bindings, availableAccounts));
    setAuthMode("cookie");
    setUsername("");
    setPassword("");
    setHasPassword(false);
    setCookieJson("");
    setFormOpen(true);
  };

  const handleStartEdit = async (binding: UserManagedAccountBinding) => {
    if (!user) return;
    setEditingBinding(binding);
    setFormMode("edit");
    setAccountName(binding.alias || binding.name);
    setAuthMode(
      binding.authMode === "server_login" ? "server_login" : "cookie",
    );
    setUsername("");
    setPassword("");
    setHasPassword(false);
    setCookieJson("");
    setFormOpen(true);

    if (onGetAccountDetail) {
      setDetailLoading(true);
      try {
        const detail = await onGetAccountDetail(user.id, binding.managedAccountId);
        setAccountName(detail.name || binding.alias || binding.name);
        setAuthMode(detail.authMode || "cookie");
        setUsername(detail.username || "");
        // 已保存的密码不回显：留空提交即保持原凭据。
        setPassword("");
        setHasPassword(Boolean(detail.hasPassword) || Boolean(detail.password));
        setCookieJson(
          detail.cookieBundle && detail.cookieBundle.length > 0
            ? JSON.stringify(detail.cookieBundle, null, 2)
            : "",
        );
      } catch (error) {
        toast.error("读取托管账号凭据失败", {
          description: error instanceof Error ? error.message : "请稍后重试",
        });
        setFormOpen(false);
        setEditingBinding(null);
      } finally {
        setDetailLoading(false);
      }
    } else if (account) {
      setAuthMode(account.authMode || "cookie");
      setUsername(account.username || "");
      setPassword("");
      setHasPassword(Boolean(account.password));
      setCookieJson(
        account.cookieBundle ? JSON.stringify(account.cookieBundle, null, 2) : "",
      );
    }
  };

  const handleBindSelected = async () => {
    if (!user || !onBind || !selectedPoolId) return;
    const targetId = Number(selectedPoolId);
    if (!Number.isFinite(targetId)) return;
    setBindingId(targetId);
    try {
      await onBind(user.id, targetId);
      setSelectedPoolId("");
      toast.success("托管账号已绑定");
    } catch (error) {
      toast.error("绑定托管账号失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setBindingId(null);
    }
  };

  const unbindExisting = async (managedAccountId: number, name: string) => {
    if (!user || !onUnbind || !window.confirm(`确认解除“${name}”的绑定？`)) return;
    setBindingId(managedAccountId);
    try {
      await onUnbind(user.id, managedAccountId);
      toast.success(`托管账号 ${name} 已解除绑定`);
    } catch (error) {
      toast.error("解除绑定失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setBindingId(null);
    }
  };

  const handlePasteCookie = async () => {
    try {
      if (!navigator?.clipboard?.readText) {
        toast.error("当前浏览器环境不支持读取剪贴板，请手动粘贴");
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        toast.error("剪贴板内容为空");
        return;
      }
      setCookieJson(text.trim());
      toast.success("已粘贴剪贴板内容");
    } catch {
      toast.error("读取剪贴板失败，请允许权限或手动粘贴");
    }
  };

  const handleClearCookie = () => {
    setCookieJson("");
  };

  const submitForm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;

    let parsedPayload: CreateUserManagedAccountPayload;
    try {
      parsedPayload = buildManagedAccountPayload(
        { name: accountName, authMode, username, password, cookieJson },
        cookieDefaultDomain,
      );
    } catch (error) {
      toast.error("托管账号凭据无效", {
        description: error instanceof Error ? error.message : "请检查输入内容",
      });
      return;
    }

    const hasCredentials = Boolean(
      parsedPayload.username || parsedPayload.password || parsedPayload.cookieBundle,
    );

    if (
      authMode === "server_login" &&
      Boolean(parsedPayload.username) !== Boolean(parsedPayload.password)
    ) {
      toast.error("账号和密码需要同时填写");
      return;
    }

    if (formMode === "create") {
      if (!hasCredentials) {
        toast.error(authMode === "cookie" ? "请输入 Cookie" : "请输入账号和密码");
        return;
      }
      setSaving(true);
      try {
        if (onCreateAccount) {
          await onCreateAccount(user.id, parsedPayload);
        } else if (onSave) {
          const { name: _ignored, ...legacyPayload } = parsedPayload;
          await onSave(user.id, legacyPayload);
        }
        toast.success(`已为 ${user.username} 新增并绑定托管账号`);
        setFormOpen(false);
        setEditingBinding(null);
      } catch (error) {
        toast.error("创建托管账号失败", {
          description: error instanceof Error ? error.message : "请稍后重试",
        });
      } finally {
        setSaving(false);
      }
      return;
    }

    if (formMode === "edit" && editingBinding) {
      if (!accountName.trim()) {
        toast.error("请输入账号名称");
        return;
      }
      if (authMode === "server_login") {
        if (!parsedPayload.username || (!hasPassword && !parsedPayload.password)) {
          toast.error("请填写方舟账号和密码");
          return;
        }
      }
      setSaving(true);
      try {
        if (onUpdateAccount) {
          const updatePayload: UpdateUserManagedAccountPayload = {
            name: accountName.trim(),
            authMode,
          };
          if (authMode === "server_login") {
            if (parsedPayload.username) updatePayload.username = parsedPayload.username;
            if (parsedPayload.password) updatePayload.password = parsedPayload.password;
            updatePayload.autoRelogin = true;
          } else if (parsedPayload.cookieBundle) {
            updatePayload.cookieBundle = parsedPayload.cookieBundle;
          }
          await onUpdateAccount(user.id, editingBinding.managedAccountId, updatePayload);
        } else if (onSave) {
          const { name: _ignored, ...legacyPayload } = parsedPayload;
          await onSave(user.id, legacyPayload);
        }
        toast.success(`托管账号 ${accountName.trim()} 已保存`);
        setFormOpen(false);
        setEditingBinding(null);
      } catch (error) {
        toast.error("保存托管账号失败", {
          description: error instanceof Error ? error.message : "请稍后重试",
        });
      } finally {
        setSaving(false);
      }
    }
  };

  return (
    <>
      {/* 主弹窗：绑定托管账号 Table 列表 */}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && formOpen) {
            handleCloseForm();
            return;
          }
          onOpenChange(nextOpen);
        }}
      >
        <DialogContent
          className="sm:max-w-4xl lg:max-w-5xl w-[92vw] h-[72vh] min-h-[520px] max-h-[85vh] flex flex-col overflow-hidden p-6"
          onEscapeKeyDown={(event) => {
            if (formOpen) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (formOpen) event.preventDefault();
          }}
        >
          <DialogHeader className="shrink-0 pr-8">
            <div className="flex items-center gap-2 text-primary">
              <KeyRound className="h-5 w-5" />
              <DialogTitle>绑定托管账号</DialogTitle>
              {!accountLoading && (
                <Badge
                  variant="secondary"
                  className="text-[11px] px-2 py-0 font-normal"
                >
                  已绑定 {bindings.length}
                </Badge>
              )}
            </div>
            <DialogDescription className="text-xs">
              {user
                ? `为 ${user.name || user.username} 管理方舟托管登录账号。`
                : "管理方舟托管登录账号。"}
              同一用户可绑定多个托管账号并在桌面端独立打开；凭据仅对超级管理员可见，不会展示给桌面用户。
            </DialogDescription>
          </DialogHeader>

          {accountLoading ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在读取绑定列表...
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/80 bg-card shadow-sm overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 px-4 py-3 border-b border-border/70 bg-muted/15 shrink-0">
                <div className="flex items-center gap-2">
                  {(onCreateAccount || onSave) && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleStartCreate}
                      disabled={listBusy}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>新增托管账号</span>
                    </Button>
                  )}
                </div>

                {onBind && unboundAccounts.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedPoolId}
                      onValueChange={setSelectedPoolId}
                      disabled={listBusy}
                    >
                      <SelectTrigger size="sm" className="w-full sm:w-56">
                        <SelectValue placeholder="从账号库选择已有账号..." />
                      </SelectTrigger>
                      <SelectContent>
                        {unboundAccounts.map((acc) => (
                          <SelectItem
                            key={acc.id}
                            value={String(acc.id)}
                            className="text-xs"
                          >
                            {acc.name} (#{acc.id})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!selectedPoolId || listBusy}
                      loading={
                        bindingId !== null && String(bindingId) === selectedPoolId
                      }
                      onClick={() => void handleBindSelected()}
                    >
                      <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>绑定已有</span>
                    </Button>
                  </div>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    桌面端会按已绑定账号展示独立浏览器登录入口
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                <ManagedAccountBindingList
                  bindings={bindings}
                  availableAccounts={availableAccounts}
                  onEdit={canEdit ? (item) => void handleStartEdit(item) : undefined}
                  onUnbind={
                    onUnbind
                      ? (item) =>
                          void unbindExisting(item.managedAccountId, item.name)
                      : undefined
                  }
                  onCheckIdentity={onCheckIdentity}
                  busyAccountId={bindingId}
                  disabled={listBusy}
                />
              </div>
            </div>
          )}

          <DialogFooter className="shrink-0 mt-0 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 独立子弹窗：新增 / 编辑托管账号凭据（关闭时仅关闭当前表单，不关闭底层列表弹窗） */}
      <Dialog
        open={open && formOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) handleCloseForm();
        }}
      >
        <DialogContent
          overlayClassName="z-[60] bg-black/45"
          className="z-[60] sm:max-w-2xl w-[92vw] max-h-[88vh] flex flex-col overflow-hidden p-6"
        >
          <DialogHeader className="shrink-0 pr-8">
            <div className="flex items-center gap-2 text-primary">
              <KeyRound className="h-5 w-5" />
              <DialogTitle>
                {formMode === "edit"
                  ? `编辑托管账号：${editingBinding?.name || ""}`
                  : "新增托管账号"}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              {formMode === "edit"
                ? "修改该托管账号的显示别名或更新登录凭据；关闭当前窗口将返回已绑定账号列表。"
                : `为 ${user?.name || user?.username || "当前用户"} 录入方舟托管凭据并自动完成绑定。`}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在读取账号凭据...
            </div>
          ) : (
            <form
              className="flex-1 min-h-0 flex flex-col gap-4"
              onSubmit={submitForm}
            >
              <div className="flex-1 min-h-0 overflow-y-auto px-1.5 -mx-1.5 py-1 space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="user-managed-name">账号名称（别名）</Label>
                    <Input
                      id="user-managed-name"
                      value={accountName}
                      onChange={(event) => setAccountName(event.target.value)}
                      autoComplete="off"
                      placeholder="例如：张三-方舟主号"
                      className="bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 transition-colors"
                      disabled={formBusy}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      桌面端将以该名称区分同一平台下的不同托管登录入口。
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="user-managed-auth-mode">认证方式</Label>
                    <Select
                      value={authMode}
                      onValueChange={(value: UserManagedAuthMode) =>
                        setAuthMode(value)
                      }
                      disabled={formBusy}
                    >
                      <SelectTrigger
                        id="user-managed-auth-mode"
                        className="h-9 text-xs bg-card border-border/80"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cookie" className="text-xs">
                          Cookie
                        </SelectItem>
                        <SelectItem value="server_login" className="text-xs">
                          账号密码
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {authMode === "server_login" ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="user-managed-username">方舟账号</Label>
                      <Input
                        id="user-managed-username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="off"
                        placeholder={
                          formMode === "edit" ? "留空保持不变" : "请输入账号"
                        }
                        className="bg-card border-border/80"
                        disabled={formBusy}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="user-managed-password">方舟密码</Label>
                      <Input
                        id="user-managed-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="new-password"
                        placeholder={
                          formMode === "edit"
                            ? hasPassword
                              ? "密码已保存，不修改请留空"
                              : "留空保持不变"
                            : "请输入密码"
                        }
                        className="bg-card border-border/80"
                        disabled={formBusy}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="user-managed-cookie">Cookie 凭据</Label>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-6 px-2.5 text-[11px] gap-1 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 hover:text-primary transition-all font-medium"
                          onClick={handlePasteCookie}
                          disabled={formBusy}
                        >
                          <ClipboardPaste className="h-3 w-3" />
                          <span>粘贴</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-6 px-2.5 text-[11px] gap-1 bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20 hover:text-destructive transition-all font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={handleClearCookie}
                          disabled={formBusy || !cookieJson}
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>清空</span>
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      id="user-managed-cookie"
                      value={cookieJson}
                      onChange={(event) => setCookieJson(event.target.value)}
                      placeholder={
                        formMode === "edit"
                          ? "留空保持不变；粘贴新 Cookie 以更新"
                          : "登录方舟后，在浏览器开发者工具里复制整段 Cookie 直接粘贴到这里；也支持 JSON 数组格式"
                      }
                      className="min-h-[220px] resize-none rounded-lg bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 px-3.5 py-3 font-mono text-[11px] leading-relaxed transition-colors"
                      disabled={formBusy}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      支持浏览器复制的 name=value; ... 原始字符串（domain 自动取方舟平台域名），或包含 name、value、domain 的 JSON 数组。
                    </p>
                  </div>
                )}
              </div>

              <DialogFooter className="shrink-0 mt-0 pt-2 border-t border-border/60">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCloseForm}
                  disabled={saving}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  loading={saving}
                  disabled={detailLoading}
                >
                  {formMode === "edit" ? "保存修改" : "创建并绑定"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
