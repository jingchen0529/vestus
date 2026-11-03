import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { DesktopUser } from "@/types/user";
import { formatDate } from "@/lib/utils";
import {
  CreateUserManagedAccountPayload,
  ManagedBindingItem,
  ManagedPlatformAccount,
  UpdateUserManagedAccountPayload,
  UserManagedAuthMode,
  UserManagedPlatformAccount,
} from "@/types/managed-platform";
import { buildManagedAccountPayload } from "@/components/users/managed-account-dialog";
import { bindableAccounts, BindingSource, submitNewBinding } from "./managed-binding-form";
import { ClipboardPaste, KeyRound, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ManagedBindingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 处于编辑模式时传入对应的绑定项；为 null 或 undefined 表示新增模式 */
  bindingToEdit?: ManagedBindingItem | null;
  users: DesktopUser[];
  allBindings?: ManagedBindingItem[];
  availableAccounts?: ManagedPlatformAccount[];
  cookieDefaultDomain?: string;
  onCreateAccount?: (
    userId: number,
    payload: CreateUserManagedAccountPayload,
  ) => Promise<void>;
  onBindAccount?: (userId: number, managedAccountId: number) => Promise<void>;
  onGetAccountDetail?: (
    userId: number,
    managedAccountId: number,
  ) => Promise<UserManagedPlatformAccount>;
  onUpdateAccount?: (
    userId: number,
    managedAccountId: number,
    payload: UpdateUserManagedAccountPayload,
  ) => Promise<void>;
}

export function ManagedBindingDialog({
  open,
  onOpenChange,
  bindingToEdit = null,
  users,
  allBindings = [],
  availableAccounts = [],
  cookieDefaultDomain,
  onCreateAccount,
  onBindAccount,
  onGetAccountDetail,
  onUpdateAccount,
}: ManagedBindingDialogProps) {
  const isEditing = Boolean(bindingToEdit);

  // Form states
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [source, setSource] = useState<BindingSource>(onCreateAccount ? "create" : "existing");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountName, setAccountName] = useState("");
  const [authMode, setAuthMode] = useState<UserManagedAuthMode>("cookie");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [cookieJson, setCookieJson] = useState("");

  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const candidates = bindableAccounts(availableAccounts, allBindings, Number(selectedUserId));

  // 初始化与重置表单
  useEffect(() => {
    let active = true;
    if (!open) {
      setDetailLoading(false);
      setSubmitting(false);
      setUsername("");
      setPassword("");
      setCookieJson("");
      return;
    }
    setDetailError(false);
    setSelectedAccountId("");
    setSource(onCreateAccount ? "create" : "existing");

    if (bindingToEdit) {
      // 编辑模式
      setSelectedUserId(String(bindingToEdit.userId));
      setAccountName(bindingToEdit.name || "");
      setAuthMode(
        bindingToEdit.authMode === "server_login" ? "server_login" : "cookie",
      );
      setUsername("");
      setPassword("");
      setCookieJson("");

      if (onGetAccountDetail) {
        setDetailLoading(true);
        onGetAccountDetail(bindingToEdit.userId, bindingToEdit.managedAccountId)
          .then((detail) => {
            if (!active) return;
            if (detail.name) setAccountName(detail.name);
            if (detail.authMode) setAuthMode(detail.authMode);
            if (detail.username) setUsername(detail.username);
            if (detail.password) setPassword(detail.password);
            if (detail.cookieBundle && detail.cookieBundle.length > 0) {
              setCookieJson(JSON.stringify(detail.cookieBundle, null, 2));
            }
          })
          .catch((error) => {
            if (!active) return;
            setDetailError(true);
            toast.error("读取托管账号凭据详情失败", {
              description: error instanceof Error ? error.message : "请稍后重试",
            });
          })
          .finally(() => {
            if (active) setDetailLoading(false);
          });
      }
    } else {
      // 新增模式
      setSelectedUserId("");
      setAccountName("");
      setAuthMode("cookie");
      setUsername("");
      setPassword("");
      setCookieJson("");
      setDetailLoading(false);
    }
    return () => { active = false; };
  }, [open, bindingToEdit, onGetAccountDetail]);

  // 当选择的用户变更时，自动生成推荐的账号别名
  const handleUserChange = (userIdStr: string) => {
    setSelectedUserId(userIdStr);
    setSelectedAccountId("");
    const targetUser = users.find((u) => String(u.id) === userIdStr);
    if (!targetUser) return;

    // 智能建议名称
    const prefix = targetUser.username || `user-${targetUser.id}`;
    const defaultName = `${prefix}-ark`;
    // 若当前名称为空或看起来是上一个自动生成的名称，则更新
    if (!accountName || accountName.endsWith("-ark") || accountName.startsWith("user-")) {
      setAccountName(defaultName);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || detailLoading || detailError) return;

    if (isEditing) {
      if (!bindingToEdit || !onUpdateAccount) return;
      if (!accountName.trim()) {
        toast.error("请输入托管账号名称（别名）");
        return;
      }

      let parsedPayload: CreateUserManagedAccountPayload;
      try {
        parsedPayload = buildManagedAccountPayload(
          { name: accountName, authMode, username, password, cookieJson },
          cookieDefaultDomain,
        );
      } catch (err: unknown) {
        toast.error("托管账号凭据无效", {
          description: err instanceof Error ? err.message : "请检查输入内容",
        });
        return;
      }

      const updatePayload: UpdateUserManagedAccountPayload = {
        name: accountName.trim(),
        authMode,
      };
      if (authMode === "server_login") {
        if (parsedPayload.username) updatePayload.username = parsedPayload.username;
        if (parsedPayload.password) updatePayload.password = parsedPayload.password;
      } else if (parsedPayload.cookieBundle && parsedPayload.cookieBundle.length > 0) {
        updatePayload.cookieBundle = parsedPayload.cookieBundle;
      }

      submittingRef.current = true;
      setSubmitting(true);
      try {
        if (onUpdateAccount) {
          await onUpdateAccount(
            bindingToEdit.userId,
            bindingToEdit.managedAccountId,
            updatePayload,
          );
          toast.success(`托管账号「${accountName.trim()}」更新成功`);
          onOpenChange(false);
        }
      } catch (err: unknown) {
        toast.error("保存托管账号失败", {
          description: err instanceof Error ? err.message : "请稍后重试",
        });
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
      return;
    }

    // 新增模式：选择已有账号只提交绑定 ID，不读取或发送凭据。
    const userId = Number(selectedUserId);
    const targetUser = users.find((user) => user.id === userId && user.status === "active");
    if (!targetUser) {
      toast.error("请选择可用的桌面用户");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await submitNewBinding({
        source,
        userId,
        accountId: Number(selectedAccountId),
        candidates,
        onCreateAccount,
        onBindAccount,
        buildPayload: () => {
          const parsed = buildManagedAccountPayload(
            { name: accountName, authMode, username, password, cookieJson },
            cookieDefaultDomain,
          );
          if (!parsed.cookieBundle && !(parsed.username && parsed.password)) {
            throw new Error(authMode === "cookie" ? "请输入 Cookie 凭据" : "方舟账号和密码需要同时填写");
          }
          return parsed;
        },
      });
      toast.success(`已为用户「${targetUser.name || targetUser.username}」${source === "existing" ? "绑定已有账号" : "新增并绑定托管账号"}`);
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error("绑定托管账号失败", {
        description: err instanceof Error ? err.message : "请稍后重试",
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submittingRef.current) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-xl w-[92vw] max-h-[88vh] flex flex-col overflow-hidden p-6">
        <DialogHeader className="shrink-0 pr-8">
          <div className="flex items-center gap-2 text-primary">
            {isEditing ? <KeyRound className="h-5 w-5" /> : <Link2 className="h-5 w-5" />}
            <DialogTitle>
              {isEditing
                ? `编辑托管账号：${bindingToEdit?.name || ""}`
                : "新增托管绑定"}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            {isEditing
              ? "修改该托管账号的显示别名或更新登录凭据，保存后桌面端将同步使用新凭据。"
              : "选择桌面用户，可创建新方舟账号，也可绑定账号库中的已有账号。"}
          </DialogDescription>
        </DialogHeader>

        {detailLoading ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2.5 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span>正在读取托管账号凭据详情...</span>
          </div>
        ) : (
          <form className="flex-1 min-h-0 flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex-1 min-h-0 overflow-y-auto px-1 -mx-1 py-1 space-y-4">
              {/* 编辑模式：只读展示关联用户和所属平台 */}
              {isEditing && bindingToEdit && (
                <div className="rounded-lg border border-border/80 bg-muted/30 p-3.5 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">关联桌面用户</span>
                    <span className="font-semibold text-foreground">
                      {bindingToEdit.userName || bindingToEdit.username}{" "}
                      <span className="text-muted-foreground font-mono">
                        (@{bindingToEdit.username})
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">托管平台</span>
                    <span className="font-medium text-foreground">
                      {bindingToEdit.platformName}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">当前凭据版本</span>
                    <span className="font-mono text-muted-foreground">
                      v{bindingToEdit.credentialVersion}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">远端身份</span>
                    <span className="font-medium text-foreground">
                      {bindingToEdit.remoteDisplayName
                        ? `${bindingToEdit.remoteDisplayName}${
                            bindingToEdit.identityCheckedAt
                              ? `（检测于 ${formatDate(bindingToEdit.identityCheckedAt)}）`
                              : ""
                          }`
                        : "尚未探测"}
                    </span>
                  </div>
                </div>
              )}

              {/* 新增模式：通过 Select 组件选择用户（单独一行） */}
              {!isEditing && (
                <div className="space-y-1.5">
                  <Label htmlFor="binding-dialog-user">
                    选择关联桌面用户 <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={selectedUserId}
                    onValueChange={handleUserChange}
                    disabled={submitting}
                  >
                    <SelectTrigger
                      id="binding-dialog-user"
                      className="h-9 text-xs bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 transition-colors"
                    >
                      <SelectValue placeholder="请选择要绑定的桌面用户..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {users.map((u) => (
                        <SelectItem key={u.id} value={String(u.id)} className="text-xs" disabled={u.status !== "active"}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{u.name || u.username}</span>
                            <span className="text-muted-foreground font-mono">
                              (@{u.username})
                            </span>
                            {u.status === "disabled" && (
                              <span className="text-[10px] text-destructive">
                                (已停用)
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {!isEditing && (
                <div className="space-y-1.5">
                  <Label htmlFor="binding-dialog-source">账号来源</Label>
                  <Select value={source} onValueChange={(value: BindingSource) => {
                    setSource(value);
                    setSelectedAccountId("");
                  }} disabled={submitting}>
                    <SelectTrigger id="binding-dialog-source" className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="create" disabled={!onCreateAccount}>创建新账号</SelectItem>
                      <SelectItem value="existing" disabled={!onBindAccount}>绑定已有账号</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {!isEditing && source === "existing" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="binding-dialog-existing">已有方舟账号</Label>
                  <Select value={selectedAccountId} onValueChange={setSelectedAccountId}
                    disabled={submitting || !selectedUserId || !candidates.length}>
                    <SelectTrigger id="binding-dialog-existing" className="h-9 text-xs">
                      <SelectValue placeholder="选择账号库中的已有账号..." />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((account) => (
                        <SelectItem key={account.id} value={String(account.id)}>
                          {account.name} · #{account.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    {!selectedUserId ? "请先选择桌面用户。" : !candidates.length
                      ? "没有可绑定的已有账号；已绑定、失效、到期或非方舟账号不会列出。"
                      : "复用账号库中的凭据，不创建新账号，也不读取或修改 Cookie。"}
                  </p>
                </div>
              ) : (
                <>
              {/* 账号名称（别名） - 单独一行 */}
              <div className="space-y-1.5">
                <Label htmlFor="binding-dialog-name">
                  账号名称（别名） <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="binding-dialog-name"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="例如：张三-方舟主号"
                  autoComplete="off"
                  className="bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 text-xs transition-colors"
                  disabled={submitting}
                />
                <p className="text-[11px] text-muted-foreground">
                  桌面端按此名称区分入口。
                </p>
              </div>

              {/* 认证方式 - 单独一行 */}
              <div className="space-y-1.5">
                <Label htmlFor="binding-dialog-auth-mode">认证方式</Label>
                <Select
                  value={authMode}
                  onValueChange={(val: UserManagedAuthMode) => setAuthMode(val)}
                  disabled={submitting}
                >
                  <SelectTrigger
                    id="binding-dialog-auth-mode"
                    className="h-9 text-xs bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 transition-colors"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cookie" className="text-xs">
                      导入 Cookie
                    </SelectItem>
                    <SelectItem value="server_login" className="text-xs">
                      账号密码
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 凭据内容 - 均单独一行 */}
              {authMode === "server_login" ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="binding-dialog-username">方舟账号</Label>
                    <Input
                      id="binding-dialog-username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="off"
                      placeholder={isEditing ? "留空保持不变" : "请输入账号"}
                      className="bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 text-xs transition-colors"
                      disabled={submitting}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="binding-dialog-password">方舟密码</Label>
                    <Input
                      id="binding-dialog-password"
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="off"
                      placeholder={isEditing ? "留空保持不变" : "请输入密码"}
                      className="bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 text-xs transition-colors"
                      disabled={submitting}
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="binding-dialog-cookie">Cookie 凭据</Label>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-6 px-2.5 text-[11px] gap-1 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 hover:text-primary transition-all font-medium"
                        onClick={handlePasteCookie}
                        disabled={submitting}
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
                        disabled={submitting || !cookieJson}
                      >
                        <Trash2 className="h-3 w-3" />
                        <span>清空</span>
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    id="binding-dialog-cookie"
                    value={cookieJson}
                    onChange={(e) => setCookieJson(e.target.value)}
                    placeholder={
                      isEditing
                        ? "留空保持不变；粘贴新 Cookie 以更新凭据"
                        : "登录方舟后，在开发者工具复制整段 Cookie 粘贴于此；支持原始 name=value; 字符串或 JSON 数组"
                    }
                    className="min-h-[160px] resize-none rounded-lg bg-muted/40 hover:bg-muted/60 focus:bg-background border-border/80 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed transition-colors"
                    disabled={submitting}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    支持浏览器原始 Cookie 字符串（自动套用方舟域名），或标准的包含 name/value/domain 的 JSON 数组。
                  </p>
                </div>
              )}
                </>
              )}
              {detailError && (
                <p role="alert" className="text-xs text-destructive">读取凭据失败，请关闭后重试；当前不能提交修改。</p>
              )}
            </div>

            <DialogFooter className="shrink-0 mt-0 pt-3 border-t border-border/60">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                loading={submitting}
                disabled={detailLoading || detailError || submitting || (isEditing
                  ? !onUpdateAccount
                  : !selectedUserId || (source === "existing"
                    ? !onBindAccount || !candidates.some((account) => String(account.id) === selectedAccountId)
                    : !onCreateAccount))}
              >
                {isEditing ? "保存修改" : "确认绑定"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
