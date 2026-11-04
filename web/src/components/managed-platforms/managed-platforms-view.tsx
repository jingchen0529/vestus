import { useMemo, useState, useEffect } from "react";
import {
  CheckCircle2,
  ClipboardPaste,
  Edit2,
  KeyRound,
  Link2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DataCard,
  PageToolbar,
  PageToolbarActions,
  PageToolbarFilters,
  ToolbarSearch,
} from "@/components/ui/page-toolbar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DesktopUser } from "@/types/user";
import { PlatformItem } from "@/types/platform";
import {
  CreateManagedPlatformAccountPayload,
  ManagedAccountStatus,
  ManagedAuthMode,
  ManagedCookieInput,
  ManagedIdentityCheckResponse,
  ManagedPlatformAccount,
  UpdateManagedPlatformAccountPayload,
} from "@/types/managed-platform";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";

const AUTH_MODE_LABELS: Record<ManagedAuthMode, string> = {
  cookie: "Cookie",
  server_login: "账号密码",
  official_sso: "官方授权",
};

const STATUS_LABELS: Record<ManagedAccountStatus, string> = {
  active: "已配置",
  expired: "已过期",
  revoked: "已撤销",
  invalid: "需处理",
};

interface ManagedAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: ManagedPlatformAccount | null;
  platforms: PlatformItem[];
  onCreate: (payload: CreateManagedPlatformAccountPayload) => Promise<void>;
  onUpdate: (id: number, payload: UpdateManagedPlatformAccountPayload) => Promise<void>;
}

function parseCookieInput(raw: string): ManagedCookieInput[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Cookie JSON 必须是非空数组");
  }
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).value !== "string" ||
      typeof (item as Record<string, unknown>).domain !== "string"
    ) {
      throw new Error("每条 Cookie 都必须包含 name、value 和 domain");
    }
  }
  return parsed as ManagedCookieInput[];
}

function ManagedAccountDialog({
  open,
  onOpenChange,
  account,
  platforms,
  onCreate,
  onUpdate,
}: ManagedAccountDialogProps) {
  const editing = Boolean(account);
  const [platformId, setPlatformId] = useState("");
  const [name, setName] = useState("");
  const [authMode, setAuthMode] = useState<ManagedAuthMode>("cookie");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [cookieJson, setCookieJson] = useState("");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPlatformId(account ? String(account.platformId) : platforms[0] ? String(platforms[0].id) : "");
    setName(account?.name || "");
    setAuthMode(account?.authMode || "cookie");
    setUsername("");
    setPassword("");
    setCookieJson("");
    setAllowedHosts(account?.allowedHosts.join("\n") || "");
    setExpiresAt(account?.expiresAt ? account.expiresAt.slice(0, 10) : "");
  }, [account, open, platforms]);

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

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      toast.error("请输入托管账号别名");
      return;
    }
    if (!editing && !platformId) {
      toast.error("请选择业务平台");
      return;
    }

    const hosts = allowedHosts
      .split(/[\n,]/)
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    const payload: UpdateManagedPlatformAccountPayload = {
      name: name.trim(),
      authMode,
      allowedHosts: hosts,
      expiresAt: expiresAt || null,
    };

    if (username.trim()) payload.username = username.trim();
    if (password) payload.password = password;
    if (cookieJson.trim()) {
      try {
        payload.cookieBundle = parseCookieInput(cookieJson.trim());
      } catch (error) {
        toast.error("Cookie JSON 无效", { description: error instanceof Error ? error.message : "请检查格式" });
        return;
      }
    }
    if (authMode === "server_login" && !editing && (!payload.username || !payload.password)) {
      toast.error("账号密码模式必须填写账号和密码");
      return;
    }
    if (authMode === "cookie" && !editing && !payload.cookieBundle) {
      toast.error("Cookie 模式必须填写 Cookie JSON");
      return;
    }

    setLoading(true);
    try {
      if (editing && account) {
        await onUpdate(account.id, payload);
        toast.success(`托管账号 ${account.name} 已更新`);
      } else {
        await onCreate({
          ...payload,
          platformId: Number(platformId),
          name: payload.name || name.trim(),
          authMode: payload.authMode || authMode,
        });
        toast.success(`托管账号 ${name.trim()} 创建成功`);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(editing ? "保存托管账号失败" : "创建托管账号失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Do not retain entered credentials in React state after the dialog is
      // closed. Reopening starts with blank write-only fields.
      setUsername("");
      setPassword("");
      setCookieJson("");
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑托管平台账号" : "新增托管平台账号"}</DialogTitle>
          <DialogDescription className="text-xs">
            后台只保存加密凭据，密码和 Cookie 不会回显；留空密钥字段表示保留已有凭据。
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="managed-platform" required={!editing}>业务平台</Label>
              <Select value={platformId} onValueChange={setPlatformId} disabled={editing || loading}>
                <SelectTrigger id="managed-platform" className="h-9 text-xs">
                  <SelectValue placeholder="选择平台" />
                </SelectTrigger>
                <SelectContent>
                  {platforms.map((platform) => (
                    <SelectItem key={platform.id} value={String(platform.id)} className="text-xs">
                      {platform.name}（#{platform.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="managed-name" required>账号别名</Label>
              <Input id="managed-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：方舟主账号" disabled={loading} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="managed-auth-mode">认证方式</Label>
            <Select value={authMode} onValueChange={(value: ManagedAuthMode) => setAuthMode(value)} disabled={loading}>
              <SelectTrigger id="managed-auth-mode" className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cookie" className="text-xs">Cookie</SelectItem>
                <SelectItem value="server_login" className="text-xs">账号密码</SelectItem>
                <SelectItem value="official_sso" className="text-xs">官方授权 / SSO</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(authMode === "server_login" || username) && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="managed-username">方舟账号</Label>
                <Input id="managed-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" placeholder={editing ? "留空保持不变" : "仅管理员可见"} disabled={loading} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="managed-password">方舟密码</Label>
                <Input id="managed-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder={editing ? "留空保持不变" : "仅管理员可见"} disabled={loading} />
              </div>
            </div>
          )}

          {authMode === "cookie" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="managed-cookie">Cookie JSON</Label>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 px-2.5 text-[11px] gap-1 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 hover:text-primary transition-all font-medium"
                    onClick={handlePasteCookie}
                    disabled={loading}
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
                    disabled={loading || !cookieJson}
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>清空</span>
                  </Button>
                </div>
              </div>
              <Textarea id="managed-cookie" value={cookieJson} onChange={(event) => setCookieJson(event.target.value)} placeholder={editing ? "留空保持不变；粘贴完整 Cookie 数组" : '[{"name":"sessionid","value":"…","domain":".example.com","path":"/","secure":true,"httpOnly":true,"sameSite":"Lax"}]'} className="min-h-[112px] font-mono text-[11px]" disabled={loading} />
              <p className="text-[11px] text-muted-foreground">必须保留 domain、path、secure、httpOnly、sameSite 等属性，页面不会保存或展示 Cookie 值。</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="managed-hosts">允许访问的域名</Label>
              <Textarea id="managed-hosts" value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} placeholder="每行一个，例如：ark.example.com" className="min-h-[80px] text-xs" disabled={loading} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="managed-expires">授权到期日</Label>
              <Input id="managed-expires" type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="h-9 text-xs" disabled={loading} />
              <p className="text-[11px] text-muted-foreground">到期后客户端不能兑换新的托管会话。</p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleDialogOpenChange(false)} disabled={loading}>取消</Button>
            <Button type="submit" loading={loading}>{editing ? "保存托管账号" : "创建托管账号"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface BindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: ManagedPlatformAccount | null;
  users: DesktopUser[];
  onBind: (accountId: number, userId: number) => Promise<void>;
}

function BindDialog({ open, onOpenChange, account, users, onBind }: BindDialogProps) {
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setUserId(users[0] ? String(users[0].id) : "");
  }, [open, users]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || !userId) {
      toast.error("请选择桌面用户");
      return;
    }
    setLoading(true);
    try {
      await onBind(account.id, Number(userId));
      toast.success(`已将 ${account.name} 绑定给桌面用户`);
      onOpenChange(false);
    } catch (error) {
      toast.error("绑定失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>绑定桌面用户</DialogTitle>
          <DialogDescription className="text-xs">用户打开对应平台时，会按此绑定领取一次性托管登录票据。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="managed-bind-user" required>桌面用户</Label>
            <Select value={userId} onValueChange={setUserId} disabled={loading}>
              <SelectTrigger id="managed-bind-user" className="h-9 text-xs"><SelectValue placeholder="选择桌面用户" /></SelectTrigger>
              <SelectContent>
                {users.filter((user) => user.status === "active").map((user) => (
                  <SelectItem key={user.id} value={String(user.id)} className="text-xs">{user.name}（{user.username}）</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>取消</Button>
            <Button type="submit" loading={loading}>确认绑定</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface ManagedPlatformsViewProps {
  accounts: ManagedPlatformAccount[];
  platforms: PlatformItem[];
  users: DesktopUser[];
  onRefresh: () => void;
  isRefreshing?: boolean;
  onCreateAccount: (payload: CreateManagedPlatformAccountPayload) => Promise<void>;
  onUpdateAccount: (id: number, payload: UpdateManagedPlatformAccountPayload) => Promise<void>;
  onBindAccount: (id: number, userId: number) => Promise<void>;
  onCheckIdentity?: (id: number) => Promise<ManagedIdentityCheckResponse>;
  onDeleteAccount?: (account: ManagedPlatformAccount) => Promise<void>;
}

export function ManagedPlatformsView({
  accounts,
  platforms,
  users,
  onRefresh,
  isRefreshing = false,
  onCreateAccount,
  onUpdateAccount,
  onBindAccount,
  onCheckIdentity,
  onDeleteAccount,
}: ManagedPlatformsViewProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ManagedAccountStatus | "SESSION_EXPIRED" | "ALL">("ALL");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedPlatformAccount | null>(null);
  const [binding, setBinding] = useState<ManagedPlatformAccount | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const platformNames = useMemo(() => new Map(platforms.map((item) => [item.id, item.name])), [platforms]);
  const filteredAccounts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return accounts.filter((account) => {
      const matchesStatus =
        statusFilter === "ALL" ||
        (statusFilter === "SESSION_EXPIRED"
          ? account.sessionStatus === "expired"
          : account.status === statusFilter);
      const matchesSearch = !needle || account.name.toLowerCase().includes(needle) || String(account.id).includes(needle) || (platformNames.get(account.platformId) || "").toLowerCase().includes(needle);
      return matchesStatus && matchesSearch;
    });
  }, [accounts, platformNames, search, statusFilter]);
  const activeCount = accounts.filter((account) => account.status === "active").length;

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };


  const handleDelete = async (account: ManagedPlatformAccount) => {
    if (!onDeleteAccount || !window.confirm(`确认撤销托管账号“${account.name}”？`)) return;
    setBusyId(account.id);
    try {
      await onDeleteAccount(account);
      toast.success(`托管账号 ${account.name} 已撤销`);
    } catch (error) {
      toast.error("撤销托管账号失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setBusyId(null);
    }
  };

  const handleCheckIdentity = async (account: ManagedPlatformAccount) => {
    if (!onCheckIdentity) return;
    setCheckingId(account.id);
    try {
      const result = await onCheckIdentity(account.id);
      if (result.state === "verified") {
        toast.success(`登录态有效：${result.account.remoteDisplayName || "身份已刷新"}`);
      } else {
        toast.error("登录态已失效，会话已标记过期", {
          description: result.detail || "上游返回未登录，请替换 Cookie",
        });
      }
      onRefresh();
    } catch (error) {
      toast.error("检查登录态失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setCheckingId(null);
    }
  };

  const statusBadge = (status: ManagedAccountStatus) => {
    if (status === "active") return <Badge variant="success" className="gap-1 text-[10px]"><CheckCircle2 className="h-3 w-3" />{STATUS_LABELS[status]}</Badge>;
    if (status === "invalid") return <Badge variant="destructive" className="gap-1 text-[10px]"><ShieldAlert className="h-3 w-3" />{STATUS_LABELS[status]}</Badge>;
    return <Badge variant="secondary" className="gap-1 text-[10px]"><XCircle className="h-3 w-3" />{STATUS_LABELS[status]}</Badge>;
  };

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-300">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="border-border/80 shadow-sm">
          <CardContent className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">托管账号</span>
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {accounts.length}
                <span className="ml-1 text-xs font-normal text-muted-foreground">个</span>
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <KeyRound className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/80 shadow-sm">
          <CardContent className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">可分发</span>
              <div className="text-2xl font-bold tracking-tight text-success">
                {activeCount}
                <span className="ml-1 text-xs font-normal text-muted-foreground">个</span>
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success">
              <CheckCircle2 className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/80 shadow-sm">
          <CardContent className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">安全边界</span>
              <div className="text-base font-bold tracking-tight text-foreground pt-1">
                密钥不回显
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <LockKeyhole className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <DataCard>
        <PageToolbar>
          <PageToolbarActions>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              <span>新增托管账号</span>
            </Button>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing}>
              <RefreshCw
                className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`}
              />
              <span>刷新</span>
            </Button>
          </PageToolbarActions>
          <PageToolbarFilters>
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="搜索别名、平台或编号..."
            />
            <div className="w-36 shrink-0">
              <Select
                value={statusFilter}
                onValueChange={(value: ManagedAccountStatus | "SESSION_EXPIRED" | "ALL") => setStatusFilter(value)}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部状态</SelectItem>
                  <SelectItem value="SESSION_EXPIRED" className="text-xs">会话已失效</SelectItem>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value} className="text-xs">
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </PageToolbarFilters>
        </PageToolbar>

        <div className="border-b border-border/60 bg-primary/5 px-4 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <LockKeyhole className="h-3.5 w-3.5 text-primary" />
            <span>托管账号由后台统一验证和分发</span>
          </div>
          <p className="mt-0.5">
            客户只领取一次性会话票据；密码和 Cookie 不会回显，也不会进入普通审计日志。
          </p>
        </div>

        {filteredAccounts.length === 0 ? (
          <div className="py-16 px-6 text-center text-muted-foreground">
            <KeyRound className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">暂无托管平台账号</p>
            <p className="mt-1 text-xs">先点击上方【新增托管账号】创建账号别名，再绑定给桌面用户。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px] text-center">ID</TableHead>
                  <TableHead>账号别名</TableHead>
                  <TableHead>业务平台</TableHead>
                  <TableHead>认证方式</TableHead>
                  <TableHead>凭据版本</TableHead>
                  <TableHead>验证时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAccounts.map((account) => (
                  <TableRow key={account.id} className="hover:bg-muted/40 transition-colors text-xs">
                    <TableCell className="text-center font-mono text-muted-foreground">
                      {account.id}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                          <KeyRound className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">{account.name}</div>
                          <div
                            className="text-[10px] text-muted-foreground"
                            title={
                              account.identityCheckedAt
                                ? `身份检测时间 ${formatDate(account.identityCheckedAt)}`
                                : undefined
                            }
                          >
                            {account.remoteDisplayName || "密钥已托管，不回显"}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">
                        {platformNames.get(account.platformId) || `平台 #${account.platformId}`}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        允许域名 {account.allowedHosts.length || 0} 个
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {AUTH_MODE_LABELS[account.authMode]}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      v{account.credentialVersion}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground font-mono">
                      {formatDate(account.lastVerifiedAt)}
                    </TableCell>
                    <TableCell>
                      <div
                        className="flex items-center gap-1.5"
                        title={account.lastError || undefined}
                      >
                        {statusBadge(account.status)}
                        {account.sessionStatus === "expired" && (
                          <Badge variant="destructive" className="gap-1 text-[10px]">
                            <ShieldAlert className="h-3 w-3" />
                            会话已失效
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex justify-end gap-1.5">
                        {onCheckIdentity && account.authMode === "cookie" && (
                          <Button
                            variant="table-action"
                            size="xs"
                            onClick={() => void handleCheckIdentity(account)}
                            disabled={checkingId === account.id || busyId === account.id}
                            className="hover:text-primary hover:bg-primary/10 hover:border-primary/30"
                          >
                            <ShieldCheck
                              className={`h-3.5 w-3.5 text-primary ${checkingId === account.id ? "animate-pulse" : ""}`}
                            />
                            <span>{checkingId === account.id ? "检查中…" : "检查登录态"}</span>
                          </Button>
                        )}
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => {
                            setEditing(account);
                            setDialogOpen(true);
                          }}
                        >
                          <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>编辑</span>
                        </Button>
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => setBinding(account)}
                          className="hover:text-primary hover:bg-primary/10 hover:border-primary/30"
                        >
                          <Link2 className="h-3.5 w-3.5 text-primary" />
                          <span>绑定</span>
                        </Button>
                        {onDeleteAccount && (
                          <Button
                            variant="table-action"
                            size="xs"
                            onClick={() => void handleDelete(account)}
                            disabled={busyId === account.id}
                            className="hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            <span>撤销</span>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DataCard>

      <ManagedAccountDialog open={dialogOpen} onOpenChange={setDialogOpen} account={editing} platforms={platforms} onCreate={onCreateAccount} onUpdate={onUpdateAccount} />
      <BindDialog open={Boolean(binding)} onOpenChange={(open) => { if (!open) setBinding(null); }} account={binding} users={users} onBind={onBindAccount} />
    </div>
  );
}

