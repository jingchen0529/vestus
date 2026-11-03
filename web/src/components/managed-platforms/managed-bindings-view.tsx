import { useEffect, useMemo, useRef, useState } from "react";
import { isManagedRecovering, managedRecoveryLabel } from "@/lib/managed-recovery";
import {
  CheckCircle2,
  Edit2,
  Link2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  UserRound,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DesktopUser } from "@/types/user";
import {
  CreateUserManagedAccountPayload,
  ManagedAuthMode,
  ManagedBindingItem,
  ManagedIdentityCheckResponse,
  ManagedPlatformAccount,
  UpdateUserManagedAccountPayload,
  UserManagedPlatformAccount,
} from "@/types/managed-platform";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { ManagedBindingDialog } from "./managed-binding-dialog";

const AUTH_MODE_LABELS: Record<ManagedAuthMode, string> = {
  cookie: "导入 Cookie",
  server_login: "服务端登录",
  official_sso: "官方授权",
};

type BindingFilter = "ALL" | "SESSION_EXPIRED" | "ACTIVE";

interface ManagedBindingsViewProps {
  bindings: ManagedBindingItem[];
  total: number;
  expiredCount: number;
  isRefreshing: boolean;
  onRefresh: () => void;
  onUnbind: (userId: number, managedAccountId: number, accountName: string) => Promise<void>;
  users?: DesktopUser[];
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
  onCheckIdentity?: (managedAccountId: number) => Promise<ManagedIdentityCheckResponse>;
}

export function ManagedBindingsView({
  bindings,
  total,
  expiredCount,
  isRefreshing,
  onRefresh,
  onUnbind,
  users = [],
  availableAccounts = [],
  cookieDefaultDomain,
  onCreateAccount,
  onBindAccount,
  onGetAccountDetail,
  onUpdateAccount,
  onCheckIdentity,
}: ManagedBindingsViewProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<BindingFilter>("ALL");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // 弹窗状态：新增与编辑
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ManagedBindingItem | null>(null);
  const refreshRef = useRef({ onRefresh, isRefreshing });
  refreshRef.current = { onRefresh, isRefreshing };
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !refreshRef.current.isRefreshing) {
        refreshRef.current.onRefresh();
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const handleOpenCreate = () => {
    setEditingItem(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (item: ManagedBindingItem) => {
    setEditingItem(item);
    setDialogOpen(true);
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return bindings.filter((item) => {
      const matchesFilter =
        filter === "ALL" ||
        (filter === "SESSION_EXPIRED" ? item.sessionStatus === "expired" : item.status === "active");
      const matchesSearch =
        !needle ||
        item.username.toLowerCase().includes(needle) ||
        (item.userName || "").toLowerCase().includes(needle) ||
        item.name.toLowerCase().includes(needle) ||
        item.platformName.toLowerCase().includes(needle);
      return matchesFilter && matchesSearch;
    });
  }, [bindings, search, filter]);


  const handleUnbind = async (item: ManagedBindingItem) => {
    if (!window.confirm(`确认解绑用户「${item.userName || item.username}」的托管账号「${item.name}」？`)) {
      return;
    }
    const key = `${item.bindingId}:unbind`;
    setBusyKey(key);
    try {
      await onUnbind(item.userId, item.managedAccountId, item.name);
    } finally {
      setBusyKey(null);
    }
  };

  const handleCheckIdentity = async (item: ManagedBindingItem) => {
    if (!onCheckIdentity) return;
    const key = `${item.bindingId}:identity`;
    setBusyKey(key);
    try {
      const result = await onCheckIdentity(item.managedAccountId);
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
      setBusyKey(null);
    }
  };

  const bindingBadge = (item: ManagedBindingItem) => {
    if (item.status === "revoked") {
      return (
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <XCircle className="h-3 w-3" />
          已解绑
        </Badge>
      );
    }
    return (
      <Badge variant="success" className="gap-1 text-[10px]">
        <CheckCircle2 className="h-3 w-3" />
        绑定中
      </Badge>
    );
  };

  const sessionBadge = (item: ManagedBindingItem) => {
    if (isManagedRecovering(item)) {
      return <Badge variant="warning" className="gap-1 text-[10px]" title={item.lastError || undefined}>
        <RefreshCw className="h-3 w-3 animate-spin" />{managedRecoveryLabel(item)}
      </Badge>;
    }
    if (item.recoveryStatus === "failed") {
      return <Badge variant="destructive" className="text-[10px]" title={item.lastError || undefined}>自动恢复失败</Badge>;
    }
    if (item.sessionStatus === "expired") {
      return (
        <Badge variant="destructive" className="gap-1 text-[10px]" title={item.lastError || undefined}>
          <ShieldAlert className="h-3 w-3" />
          会话已失效
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
        会话正常
      </Badge>
    );
  };

  return (
    <div className="space-y-4 p-1">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="border-border/80 shadow-sm">
          <CardContent className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">绑定总数</span>
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {total}
                <span className="ml-1 text-xs font-normal text-muted-foreground">条</span>
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Link2 className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/80 shadow-sm">
          <CardContent className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">会话已失效</span>
              <div className="text-2xl font-bold tracking-tight text-destructive">
                {expiredCount}
                <span className="ml-1 text-xs font-normal text-muted-foreground">条</span>
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <ShieldAlert className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/80 shadow-sm">
          <CardContent className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">涉及用户</span>
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {new Set(bindings.map((item) => item.userId)).size}
                <span className="ml-1 text-xs font-normal text-muted-foreground">人</span>
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <UserRound className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <DataCard>
        <PageToolbar>
          <PageToolbarActions>
            {(onCreateAccount || onBindAccount) && (
              <Button size="sm" onClick={handleOpenCreate}>
                <Plus className="h-3.5 w-3.5" />
                <span>新增绑定</span>
              </Button>
            )}
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
              placeholder="搜索用户、账号或平台..."
            />
            <div className="w-36 shrink-0">
              <Select value={filter} onValueChange={(value: BindingFilter) => setFilter(value)}>
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部绑定</SelectItem>
                  <SelectItem value="SESSION_EXPIRED" className="text-xs">会话已失效</SelectItem>
                  <SelectItem value="ACTIVE" className="text-xs">绑定中</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PageToolbarFilters>
        </PageToolbar>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>平台</TableHead>
              <TableHead>托管账号</TableHead>
              <TableHead>认证方式</TableHead>
              <TableHead>凭据版本</TableHead>
              <TableHead>绑定状态</TableHead>
              <TableHead>会话状态</TableHead>
              <TableHead>最近状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => {
              const rowKey = String(item.bindingId);
              const busy = busyKey === `${item.bindingId}:unbind`;
              const identityBusy = busyKey === `${item.bindingId}:identity`;
              return (
                <TableRow key={rowKey}>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">
                        {item.userName || item.username}
                      </span>
                      <span className="text-[11px] text-muted-foreground font-mono">
                        @{item.username}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {item.platformName}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      {item.remoteDisplayName && item.remoteDisplayName !== item.name ? (
                        onCheckIdentity && item.authMode !== "official_sso" && !isManagedRecovering(item) ? (
                          <button
                            type="button"
                            className="text-left text-[11px] text-muted-foreground hover:text-primary hover:underline underline-offset-2 transition-colors disabled:opacity-60"
                            title={`平台身份：${item.remoteDisplayName}；点击重新校验登录态`}
                            onClick={() => void handleCheckIdentity(item)}
                            disabled={identityBusy}
                          >
                            {identityBusy ? "检查中…" : item.remoteDisplayName}
                          </button>
                        ) : (
                          <span
                            className="text-[11px] text-muted-foreground"
                            title={`平台身份：${item.remoteDisplayName}`}
                          >
                            {item.remoteDisplayName}
                          </span>
                        )
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Badge variant="outline" className="text-[10px]">
                      {AUTH_MODE_LABELS[item.authMode] ?? item.authMode}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    v{item.credentialVersion}
                  </TableCell>
                  <TableCell>{bindingBadge(item)}</TableCell>
                  <TableCell>{sessionBadge(item)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground font-mono">
                    {formatDate(item.lastVerifiedAt)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <div className="flex justify-end gap-1.5">
                      {onCheckIdentity && item.authMode !== "official_sso" && !isManagedRecovering(item) && (
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => void handleCheckIdentity(item)}
                          disabled={busy || identityBusy}
                        >
                          <ShieldCheck
                            className={`h-3.5 w-3.5 text-primary ${identityBusy ? "animate-pulse" : ""}`}
                          />
                          <span>{identityBusy ? "检查中…" : "检查登录态"}</span>
                        </Button>
                      )}
                      {onUpdateAccount && (
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => handleOpenEdit(item)}
                          disabled={busy}
                        >
                          <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>编辑</span>
                        </Button>
                      )}
                      <Button
                        variant="table-action"
                        size="xs"
                        onClick={() => void handleUnbind(item)}
                        disabled={busy || item.status === "revoked"}
                      >
                        <ShieldOff className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>解绑</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {filtered.length === 0 && (
          <div className="py-10 text-center">
            <Link2 className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 text-xs text-foreground font-medium">暂无符合条件的绑定记录</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              在「桌面用户」或点击上方「新增绑定」为用户绑定托管账号。
            </p>
          </div>
        )}
      </DataCard>

      <ManagedBindingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        bindingToEdit={editingItem}
        users={users}
        allBindings={bindings}
        availableAccounts={availableAccounts}
        cookieDefaultDomain={cookieDefaultDomain}
        onCreateAccount={onCreateAccount}
        onBindAccount={onBindAccount}
        onGetAccountDetail={onGetAccountDetail}
        onUpdateAccount={onUpdateAccount}
      />
    </div>
  );
}
