import { useState, useMemo } from "react";
import {
  Server,
  Plus,
  Edit2,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Power,
  PowerOff,
  ShieldCheck,
  Globe,
  Star,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  DataCard,
  PageToolbar,
  PageToolbarActions,
  PageToolbarFilters,
  ToolbarSearch,
} from "@/components/ui/page-toolbar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { toast } from "sonner";

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
      <div className="flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-xs text-success">
        <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
        <span>
          多条代理可同时启用。在【用户管理】中可为每个用户单独指定 VPN 节点；未单独配置的用户走【默认】节点，全局同时只有一条默认。
        </span>
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
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success">
              <Server className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">启用节点数</p>
              <p className="text-2xl font-bold tracking-tight mt-1 text-success">
                {stats.active}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success">
              <CheckCircle2 className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">暂时停用</p>
              <p className="text-2xl font-bold tracking-tight mt-1 text-muted-foreground">
                {stats.disabled}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <XCircle className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. Main Proxy Table Card */}
      <DataCard>
        <PageToolbar>
          <PageToolbarActions>
            <Button size="sm" onClick={handleOpenCreate}>
              <Plus className="h-3.5 w-3.5" />
              <span>新增代理</span>
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
              onChange={setSearch}
              placeholder="搜索代理名称、主机或端口..."
            />

            <div className="w-36 shrink-0">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">全部状态</SelectItem>
                  <SelectItem value="active" className="text-xs">仅正常启用</SelectItem>
                  <SelectItem value="disabled" className="text-xs">仅已停用</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PageToolbarFilters>
        </PageToolbar>

        {/* Table */}
        {filteredProxies.length === 0 ? (
          <div className="py-16 px-6 text-center text-muted-foreground">
            <Server className="mx-auto h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-foreground">暂无符合条件的网络代理节点</p>
            <p className="text-xs mt-1 text-muted-foreground">
              {search.trim() || statusFilter !== "ALL"
                ? "请尝试调整搜索关键词或状态筛选条件"
                : "点击上方【新增代理】录入首个代理配置"}
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
                  <TableHead className="w-[220px] text-right">操作</TableHead>
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
                        <div className="h-8 w-8 rounded-lg bg-success/10 text-success flex items-center justify-center shadow-sm shrink-0">
                          <Server className="h-4 w-4" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-semibold text-foreground text-xs truncate inline-flex items-center gap-1.5">
                            {proxy.name}
                            {proxy.isDefault && (
                              <Badge variant="success" className="text-[10px] px-1.5 py-0 shrink-0">
                                默认
                              </Badge>
                            )}
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
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-warning/10 text-warning font-medium"
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
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => handleOpenEdit(proxy)}
                        >
                          <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>编辑</span>
                        </Button>

                        {!proxy.isDefault && (
                          <Button
                            variant="table-action"
                            size="xs"
                            disabled={proxy.status !== "active"}
                            title={
                              proxy.status !== "active"
                                ? "停用节点不能作为默认，请先启用"
                                : "设为默认节点，未单独配置 VPN 的用户将走这条"
                            }
                            onClick={async () => {
                              try {
                                await onUpdateProxy(proxy.id, { isDefault: true });
                                toast.success(`已将 ${proxy.name} 设为默认节点`);
                              } catch (err: any) {
                                toast.error("设置默认失败", { description: err.message });
                              }
                            }}
                            className="hover:text-success dark:hover:text-success hover:bg-success/10 hover:border-success/30"
                          >
                            <Star className="h-3.5 w-3.5 text-success" />
                            <span>设为默认</span>
                          </Button>
                        )}

                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => onToggleProxyStatus(proxy)}
                          className={
                            proxy.status === "active"
                              ? "hover:text-warning dark:hover:text-warning hover:bg-warning/10 hover:border-warning/30"
                              : "hover:text-success dark:hover:text-success hover:bg-success/10 hover:border-success/30"
                          }
                        >
                          {proxy.status === "active" ? (
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

                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => handlePromptDelete(proxy)}
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
        )}
      </DataCard>

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
              <Trash2 className="h-4 w-4 shrink-0" />
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
              <p className="text-warning">
                ⚠️ 被指派到该节点的用户将回落到默认节点；若删除的正是默认节点，未单独配置 VPN
                的用户将回落到第一个启用节点。该操作不可撤销。
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
