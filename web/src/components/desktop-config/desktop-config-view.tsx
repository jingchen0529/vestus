import { useState, useMemo } from "react";
import {
  Server,
  Plus,
  Edit2,
  Trash2,
  Search,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Globe,
  MoreHorizontal,
  Power,
  PowerOff,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ProxyItem, CreateProxyPayload, UpdateProxyPayload } from "@/types/proxy";
import { ProxyDialog } from "./proxy-dialog";

interface DesktopConfigViewProps {
  proxies: ProxyItem[];
  onRefresh: () => void;
  isRefreshing?: boolean;
  onCreateProxy: (payload: CreateProxyPayload) => Promise<void>;
  onUpdateProxy: (id: number, payload: UpdateProxyPayload) => Promise<void>;
  onToggleProxyStatus: (proxy: ProxyItem) => Promise<void>;
  onDeleteProxy: (proxy: ProxyItem) => Promise<void>;
}

export function DesktopConfigView({
  proxies,
  onRefresh,
  isRefreshing = false,
  onCreateProxy,
  onUpdateProxy,
  onToggleProxyStatus,
  onDeleteProxy,
}: DesktopConfigViewProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // Modal State
  const [dialogOpen, setDialogOpen] = useState(false);
  const [proxyToEdit, setProxyToEdit] = useState<ProxyItem | null>(null);

  // Delete State
  const [deleteTarget, setDeleteTarget] = useState<ProxyItem | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Stats calculation
  const stats = useMemo(() => {
    const total = proxies.length;
    const active = proxies.filter((p) => p.status === "active").length;
    const disabled = total - active;
    return { total, active, disabled };
  }, [proxies]);

  // Filtered List
  const filteredProxies = useMemo(() => {
    return proxies.filter((p) => {
      const matchSearch =
        !search.trim() ||
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.host.toLowerCase().includes(search.toLowerCase()) ||
        String(p.port).includes(search) ||
        String(p.id) === search.trim() ||
        (p.username && p.username.toLowerCase().includes(search.toLowerCase()));

      const matchStatus =
        statusFilter === "ALL" ||
        (statusFilter === "active" && p.status === "active") ||
        (statusFilter === "disabled" && p.status === "disabled");

      return matchSearch && matchStatus;
    });
  }, [proxies, search, statusFilter]);

  const handleOpenCreate = () => {
    setProxyToEdit(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (proxy: ProxyItem) => {
    setProxyToEdit(proxy);
    setDialogOpen(true);
  };

  const handlePromptDelete = (proxy: ProxyItem) => {
    setDeleteTarget(proxy);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await onDeleteProxy(deleteTarget);
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    } catch {
      // Toast handled by parent or mutation
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-300">
      {/* Notice Banner */}
      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-300">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
        <span>全局最多启用一条代理；启用新代理时会自动停用原代理，当前启用代理将下发给全部桌面用户。</span>
      </div>

      {/* 1. Metric Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="border-border/80 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">代理节点总数</p>
              <p className="text-2xl font-bold tracking-tight mt-1 text-foreground">
                {stats.total}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Server className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">当前生效代理</p>
              <p className="text-2xl font-bold tracking-tight mt-1 text-emerald-600 dark:text-emerald-400">
                {stats.active}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">暂时停用</p>
              <p className="text-2xl font-bold tracking-tight mt-1 text-slate-600 dark:text-slate-400">
                {stats.disabled}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-500/10 text-slate-600 dark:text-slate-400">
              <XCircle className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. Main Proxy Table Card */}
      <Card className="border-border/80 shadow-sm">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4 text-emerald-600" />
            <span>网络代理列表</span>
            <Badge variant="secondary" className="font-mono text-xs px-2 py-0.5">
              {filteredProxies.length}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            全局统一管理网络代理节点，支持节点配置、直连域名例外与一键启/停用
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          {/* Action, Search & Filter Bar */}
          <div className="p-4 border-b bg-muted/10 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {/* Left Action Buttons */}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                onClick={handleOpenCreate}
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 text-xs rounded-lg border-border/80 bg-background hover:bg-accent text-foreground shadow-xs font-normal"
              >
                <Plus className="h-4 w-4 text-muted-foreground" />
                <span>新增代理</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isRefreshing}
                className="h-9 gap-1.5 px-3 text-xs rounded-lg border-border/80 bg-background hover:bg-accent text-foreground shadow-xs font-normal"
              >
                <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`} />
                <span>刷新</span>
              </Button>
            </div>

            {/* Right Search and Status Filter */}
            <div className="flex flex-1 items-center justify-end gap-2.5">
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="搜索代理名称、主机或端口..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-9 text-xs bg-background"
                />
              </div>

              <div className="w-36 shrink-0">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-9 text-xs bg-background">
                    <SelectValue placeholder="全部状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL" className="text-xs">全部状态</SelectItem>
                    <SelectItem value="active" className="text-xs">仅正常启用</SelectItem>
                    <SelectItem value="disabled" className="text-xs">仅已停用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Table */}
          {filteredProxies.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <Server className="mx-auto h-10 w-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium text-foreground">暂无符合条件的网络代理节点</p>
              <p className="text-xs mt-1 text-muted-foreground">
                {search.trim() || statusFilter !== "ALL"
                  ? "请尝试调整搜索关键词或状态筛选条件"
                  : "点击左侧【新增代理】录入首个代理配置"}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px] text-center">ID</TableHead>
                    <TableHead className="min-w-[160px]">代理节点名称</TableHead>
                    <TableHead className="min-w-[200px]">主机与端口 (Host:Port)</TableHead>
                    <TableHead className="min-w-[120px]">认证账号</TableHead>
                    <TableHead className="min-w-[160px]">直连白名单</TableHead>
                    <TableHead className="w-[120px] text-center">状态</TableHead>
                    <TableHead className="w-[160px] text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProxies.map((proxy) => (
                    <TableRow key={proxy.id} className="hover:bg-muted/40 transition-colors text-xs">
                      {/* ID */}
                      <TableCell className="text-center font-mono text-muted-foreground font-medium">
                        #{proxy.id}
                      </TableCell>

                      {/* Name */}
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <div className="h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center shadow-xs shrink-0">
                            <Server className="h-4 w-4" />
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-foreground text-xs truncate">
                              {proxy.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              节点 #{proxy.id}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      {/* Host:Port */}
                      <TableCell className="font-mono text-xs">
                        <span className="text-foreground font-medium">{proxy.host}</span>
                        <span className="text-muted-foreground">:{proxy.port}</span>
                      </TableCell>

                      {/* Username */}
                      <TableCell className="font-mono text-muted-foreground">
                        {proxy.username || "—"}
                      </TableCell>

                      {/* Bypass Hosts */}
                      <TableCell>
                        {(proxy.bypassHosts?.length ?? 0) > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium"
                            title={proxy.bypassHosts!.join("\n")}
                          >
                            <Globe className="w-3 h-3" />
                            <span>直连 {proxy.bypassHosts!.length} 个域名</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">全部走代理</span>
                        )}
                      </TableCell>

                      {/* Status */}
                      <TableCell className="text-center">
                        {proxy.status === "active" ? (
                          <Badge variant="success" className="gap-1 text-[10px]">
                            <CheckCircle2 className="h-3 w-3" />
                            <span>已启用</span>
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <XCircle className="h-3 w-3" />
                            <span>已停用</span>
                          </Badge>
                        )}
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleOpenEdit(proxy)}
                            className="h-8 px-2.5 text-xs gap-1.5 rounded-lg border-border/80 bg-background hover:bg-accent text-foreground shadow-xs font-normal"
                          >
                            <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>编辑</span>
                          </Button>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 w-8 p-0 rounded-lg border-border/80 bg-background hover:bg-accent text-muted-foreground hover:text-foreground shadow-xs"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">更多操作</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem
                                onClick={() => onToggleProxyStatus(proxy)}
                                className="gap-2 text-xs cursor-pointer"
                              >
                                {proxy.status === "active" ? (
                                  <>
                                    <PowerOff className="h-3.5 w-3.5 text-amber-600" />
                                    <span className="text-amber-600">停用节点</span>
                                  </>
                                ) : (
                                  <>
                                    <Power className="h-3.5 w-3.5 text-emerald-600" />
                                    <span className="text-emerald-600">启用节点</span>
                                  </>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handlePromptDelete(proxy)}
                                className="gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer font-medium"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>删除节点</span>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <ProxyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        proxyToEdit={proxyToEdit}
        onSubmitCreate={onCreateProxy}
        onSubmitUpdate={onUpdateProxy}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive mb-1">
              <Trash2 className="h-5 w-5" />
              <DialogTitle>确认删除此代理节点？</DialogTitle>
            </div>
            <DialogDescription className="text-xs space-y-2">
              <p>
                即将彻底删除代理节点{" "}
                <strong className="text-foreground">
                  {deleteTarget?.name} ({deleteTarget?.host}:{deleteTarget?.port})
                </strong>
                。
              </p>
              <p className="text-amber-600 dark:text-amber-400">
                ⚠️ 删除后所有桌面端将不再通过此节点建立代理连接。该操作不可撤销。
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isDeleting}
              className="text-xs"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirmDelete}
              loading={isDeleting}
              className="text-xs font-semibold"
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
