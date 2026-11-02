import { useEffect, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DesktopUser } from "@/types/user";
import {
  ManagedPlatformAccount,
  UserManagedAuthMode,
  UserManagedAccountBinding,
  UserManagedPlatformAccount,
  UserManagedPlatformAccountPayload,
} from "@/types/managed-platform";
import { parseCookieInput } from "@/lib/cookie-parser";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

export interface ManagedAccountFormValues {
  authMode: UserManagedAuthMode;
  username: string;
  password: string;
  cookieJson: string;
}

export function buildManagedAccountPayload(
  values: ManagedAccountFormValues,
  cookieDefaultDomain?: string,
): UserManagedPlatformAccountPayload {
  const payload: UserManagedPlatformAccountPayload = {
    authMode: values.authMode,
  };
  if (values.authMode === "server_login") {
    if (values.username.trim()) payload.username = values.username.trim();
    if (values.password) payload.password = values.password;
  } else if (values.cookieJson.trim()) {
    payload.cookieBundle = parseCookieInput(values.cookieJson.trim(), cookieDefaultDomain);
  }
  return payload;
}

export function ManagedAccountBindingList({
  bindings,
}: {
  bindings: UserManagedAccountBinding[];
}) {
  if (bindings.length === 0) {
    return <div className="text-[11px] text-muted-foreground">暂未绑定账号</div>;
  }
  return (
    <div className="space-y-1.5">
      {bindings.map((item) => (
        <div key={item.managedAccountId} className="flex items-center justify-between gap-2 rounded-md bg-background px-2.5 py-2 text-xs">
          <div>
            <div className="font-medium text-foreground">{item.name}</div>
            <div className="text-[10px] text-muted-foreground">{item.platformName || `平台 #${item.platformId}`} · {item.status}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface ManagedAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: DesktopUser | null;
  account: UserManagedPlatformAccount | null;
  accountLoading?: boolean;
  /** 由方舟平台 URL 推导的 Cookie 默认 domain；粘贴浏览器原始 Cookie 字符串时必需。 */
  cookieDefaultDomain?: string;
  onSave: (userId: number, payload: UserManagedPlatformAccountPayload) => Promise<void>;
  onDelete: (userId: number) => Promise<void>;
  bindings?: UserManagedAccountBinding[];
  availableAccounts?: ManagedPlatformAccount[];
  onBind?: (userId: number, managedAccountId: number) => Promise<void>;
  onUnbind?: (userId: number, managedAccountId: number) => Promise<void>;
}

export function ManagedAccountDialog({
  open,
  onOpenChange,
  user,
  account,
  accountLoading = false,
  cookieDefaultDomain,
  onSave,
  onDelete,
  bindings = [],
  availableAccounts = [],
  onBind,
  onUnbind,
}: ManagedAccountDialogProps) {
  const [authMode, setAuthMode] = useState<UserManagedAuthMode>("cookie");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [cookieJson, setCookieJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bindingId, setBindingId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setAuthMode(account?.authMode || "cookie");
    setUsername(account?.username || "");
    setPassword(account?.password || "");
    setCookieJson(account?.cookieBundle ? JSON.stringify(account.cookieBundle, null, 2) : "");
  }, [account, open]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;
    let payload: UserManagedPlatformAccountPayload;
    try {
      payload = buildManagedAccountPayload({ authMode, username, password, cookieJson }, cookieDefaultDomain);
    } catch (error) {
      toast.error("托管账号凭据无效", {
        description: error instanceof Error ? error.message : "请检查输入内容",
      });
      return;
    }
    const hasCredentials = Boolean(payload.username || payload.password || payload.cookieBundle);
    if (!account && !hasCredentials) {
      toast.error(authMode === "cookie" ? "请输入 Cookie" : "请输入账号和密码");
      return;
    }
    if (authMode === "server_login" && Boolean(payload.username) !== Boolean(payload.password)) {
      toast.error("账号和密码需要同时填写");
      return;
    }
    setSaving(true);
    try {
      await onSave(user.id, payload);
      toast.success(`用户 ${user.username} 的托管账号已保存`);
      onOpenChange(false);
    } catch (error) {
      toast.error("保存托管账号失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!user || !account) return;
    if (!window.confirm(`确认解除用户“${user.username}”的托管账号绑定？`)) return;
    setDeleting(true);
    try {
      await onDelete(user.id);
      toast.success(`用户 ${user.username} 的托管账号已解除绑定`);
      onOpenChange(false);
    } catch (error) {
      toast.error("解除绑定失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setDeleting(false);
    }
  };

  const busy = saving || deleting || accountLoading;
  const boundIds = new Set(bindings.map((item) => item.managedAccountId));

  const bindExisting = async (managedAccountId: number) => {
    if (!user || !onBind) return;
    setBindingId(managedAccountId);
    try {
      await onBind(user.id, managedAccountId);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary">
            <KeyRound className="h-5 w-5" />
            <DialogTitle>绑定托管账号</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            {user ? `为 ${user.name || user.username} 配置方舟托管登录凭据。` : "配置方舟托管登录凭据。"}
            只有超级管理员可以修改；凭据仅对超级管理员可见，不会展示给桌面用户。
          </DialogDescription>
        </DialogHeader>

        {accountLoading ? (
          <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在读取绑定状态...
          </div>
        ) : (
          <form className="space-y-4 py-2" onSubmit={submit}>
            {(bindings.length > 0 || availableAccounts.length > 0) && (
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="text-xs font-semibold text-foreground">已绑定托管账号</div>
                <ManagedAccountBindingList bindings={bindings} />
                {onUnbind && bindings.length > 0 && (
                  <div className="space-y-1.5 border-t border-border/60 pt-2">
                    {bindings.map((item) => (
                      <div key={item.managedAccountId} className="flex items-center justify-between gap-2 text-xs">
                        <span>解除 {item.name}</span>
                        <Button type="button" variant="ghost" size="xs" className="text-destructive" onClick={() => void unbindExisting(item.managedAccountId, item.name)} disabled={bindingId === item.managedAccountId || busy}>
                          <Trash2 className="h-3 w-3" />解除
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {onBind && availableAccounts.some((item) => !boundIds.has(item.id)) && (
                  <div className="space-y-1.5 border-t border-border/60 pt-2">
                    <div className="text-[11px] text-muted-foreground">绑定账号库中的其他账号</div>
                    {availableAccounts.filter((item) => !boundIds.has(item.id)).map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2 text-xs">
                        <span>{item.name} · #{item.id}</span>
                        <Button type="button" variant="outline" size="xs" onClick={() => void bindExisting(item.id)} disabled={bindingId === item.id || busy}>
                          {bindingId === item.id ? "绑定中" : "绑定"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="user-managed-auth-mode">认证方式</Label>
              <Select value={authMode} onValueChange={(value: UserManagedAuthMode) => setAuthMode(value)} disabled={busy}>
                <SelectTrigger id="user-managed-auth-mode" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cookie" className="text-xs">Cookie</SelectItem>
                  <SelectItem value="server_login" className="text-xs">账号密码</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {authMode === "server_login" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="user-managed-username">方舟账号</Label>
                  <Input id="user-managed-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" placeholder={account ? "留空保持不变" : "请输入账号"} disabled={busy} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="user-managed-password">方舟密码</Label>
                  <Input id="user-managed-password" type="text" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" placeholder={account ? "留空保持不变" : "请输入密码"} disabled={busy} />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="user-managed-cookie">Cookie</Label>
                <Textarea id="user-managed-cookie" value={cookieJson} onChange={(event) => setCookieJson(event.target.value)} placeholder={account ? "留空保持不变；粘贴新 Cookie 以更新" : "登录方舟后，在浏览器开发者工具里复制整段 Cookie 直接粘贴到这里；也支持 JSON 数组格式"} className="min-h-[140px] font-mono text-[11px]" disabled={busy} />
                <p className="text-[11px] text-muted-foreground">支持浏览器复制的 name=value; ... 原始字符串（domain 自动取方舟平台域名），或包含 name、value、domain 的 JSON 数组。</p>
              </div>
            )}

            <DialogFooter>
              {account && (
                <Button type="button" variant="ghost" className="mr-auto gap-1.5 text-xs text-destructive" onClick={() => void remove()} disabled={busy}>
                  <Trash2 className="h-3.5 w-3.5" />解除绑定
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
              <Button type="submit" loading={saving}>{account ? "保存配置" : "绑定托管账号"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

