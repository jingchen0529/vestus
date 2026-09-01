import { useState, useMemo } from "react";
import {
  Globe,
  Plus,
  Edit2,
  Trash2,
  ExternalLink,
  Search,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Copy,
  Power,
  PowerOff,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
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
import { PlatformDialog } from "@/components/desktop-config/platform-dialog";
import { PlatformItem, CreatePlatformPayload, UpdatePlatformPayload } from "@/types/platform";
import { toast } from "sonner";

interface PlatformsViewProps {
  platforms: PlatformItem[];
  onRefresh: () => void;
  isRefreshing?: boolean;
  onCreatePlatform: (payload: CreatePlatformPayload) => Promise<void>;
  onUpdatePlatform: (id: number, payload: UpdatePlatformPayload) => Promise<void>;
  onTogglePlatformStatus: (platform: PlatformItem) => Promise<void>;
  onDeletePlatform: (platform: PlatformItem) => Promise<void>;
}

export function PlatformsView({
  platforms,
  onRefresh,
  isRefreshing = false,
  onCreatePlatform,
  onUpdatePlatform,
  onTogglePlatformStatus,
  onDeletePlatform,
}: PlatformsViewProps) {
  // Search & Filter state
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // Modal states
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPlatform, setEditingPlatform] = useState<PlatformItem | null>(null);

  // Delete confirmation state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [platformToDelete, setPlatformToDelete] = useState<PlatformItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Filtered platforms
  const filteredPlatforms = useMemo(() => {
    return platforms.filter((p) => {
      const matchSearch =
        !search.trim() ||
        p.name.toLowerCase().includes(search.trim().toLowerCase()) ||
        p.url.toLowerCase().includes(search.trim().toLowerCase()) ||
        String(p.id).includes(search.trim());

      const matchStatus =
        statusFilter === "ALL" ||
        (statusFilter === "active" && p.status === "active") ||
        (statusFilter === "disabled" && p.status !== "active");

      return matchSearch && matchStatus;
    });
  }, [platforms, search, statusFilter]);

  // Platform statistics
  const activeCount = platforms.filter((p) => p.status === "active").length;
  const disabledCount = platforms.length - activeCount;

  const handleOpenCreate = () => {
    setEditingPlatform(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (platform: PlatformItem) => {
    setEditingPlatform(platform);
    setDialogOpen(true);
  };

  const handleOpenDelete = (platform: PlatformItem) => {
    setPlatformToDelete(platform);
    setDeleteConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!platformToDelete) return;
    setIsDeleting(true);
    try {
      await onDeletePlatform(platformToDelete);
      setDeleteConfirmOpen(false);
      setPlatformToDelete(null);
    } catch (err: any) {
      toast.error("删除失败", { description: err.message || "请稍后重试" });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success("网址已复制到剪贴板");
  };

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-300">
      {/* 1. Header Overview Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Total Platforms */}
        <Card className="border-border/80 bg-gradient-to-br from-card to-card/60 shadow-xs">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">平台总数</span>
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {platforms.length}
                <span className="text-xs font-normal text-muted-foreground ml-1">个</span>
              </div>
            </div>
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <Globe className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        {/* Active Platforms */}
        <Card className="border-border/80 bg-gradient-to-br from-card to-card/60 shadow-xs">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">正常启用（已分发）</span>
              <div className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
                {activeCount}
                <span className="text-xs font-normal text-muted-foreground ml-1">个</span>
              </div>
            </div>
            <div className="h-10 w-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        {/* Disabled Platforms */}
        <Card className="border-border/80 bg-gradient-to-br from-card to-card/60 shadow-xs">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">已停用 / 下架</span>
              <div className="text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
                {disabledCount}
                <span className="text-xs font-normal text-muted-foreground ml-1">个</span>
              </div>
            </div>
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400">
              <XCircle className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. Main Platform Management Card */}
      <Card className="border-border/80 shadow-sm">
        <CardContent className="p-0">
          {/* Action, Search & Filter Bar */}
          <div className="p-3 border-b bg-muted/10 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
            {/* Action Buttons on Left */}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isRefreshing}
                className="h-8 gap-1.5 px-2.5 text-xs rounded-md border-border/60 bg-background/80 hover:bg-muted text-foreground shadow-none font-normal transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`} />
                <span>刷新</span>
              </Button>
              <Button
                onClick={handleOpenCreate}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs rounded-md border-border/60 bg-background/80 hover:bg-muted text-foreground shadow-none font-normal transition-colors"
              >
                <Plus className="h-4 w-4 text-muted-foreground" />
                <span>新增平台</span>
              </Button>
            </div>

            {/* Search and Status Filter on Right */}
            <div className="flex flex-1 items-center justify-end gap-2">
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="搜索平台名称、网址或编号..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-8 text-xs rounded-md border-border/60 bg-background/80 shadow-none"
                />
              </div>

              <div className="w-36 shrink-0">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-8 text-xs rounded-md border-border/60 bg-background/80 shadow-none">
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
          {filteredPlatforms.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <Globe className="mx-auto h-10 w-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium text-foreground">暂无符合条件的业务平台</p>
              <p className="text-xs mt-1 text-muted-foreground">
                {search.trim() || statusFilter !== "ALL"
                  ? "请尝试调整搜索关键词或状态筛选条件"
                  : "点击右上角【新增平台】录入首个业务平台入口"}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px] text-center">ID</TableHead>
                    <TableHead className="min-w-[180px]">平台名称</TableHead>
                    <TableHead className="min-w-[280px]">访问入口网址 (URL)</TableHead>
                    <TableHead className="w-[100px] text-center">排序权重</TableHead>
                    <TableHead className="w-[120px] text-center">分发状态</TableHead>
                    <TableHead className="w-[220px] text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPlatforms.map((platform) => (
                    <TableRow key={platform.id} className="hover:bg-muted/40 transition-colors text-xs">
                      {/* ID */}
                      <TableCell className="text-center font-mono text-muted-foreground font-medium">
                        {platform.id}
                      </TableCell>

                      {/* Name */}
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          {platform.iconUrl ? (
                            <div className="h-8 w-8 rounded-lg bg-white dark:bg-slate-900 border border-border/80 p-1 flex items-center justify-center shadow-xs shrink-0 overflow-hidden">
                              <img
                                src={platform.iconUrl}
                                alt={platform.name}
                                className="w-full h-full object-contain"
                              />
                            </div>
                          ) : (
                            <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shadow-xs shrink-0">
                              <Globe className="h-4 w-4" />
                            </div>
                          )}
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-foreground text-xs truncate">
                              {platform.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              ID: #{platform.id}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      {/* URL */}
                      <TableCell>
                        <div className="flex items-center gap-1.5 max-w-md">
                          <a
                            href={platform.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 font-mono text-[11px] text-primary hover:underline truncate"
                            title={platform.url}
                          >
                            <span className="truncate">{platform.url}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                          </a>
                          <button
                            type="button"
                            onClick={() => handleCopyUrl(platform.url)}
                            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted transition-colors shrink-0"
                            title="复制网址"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </TableCell>

                      {/* Sort Order */}
                      <TableCell className="text-center font-mono font-medium">
                        <span className="inline-block px-2 py-0.5 rounded bg-muted/60 text-[11px]">
                          {platform.sortOrder}
                        </span>
                      </TableCell>

                      {/* Status */}
                      <TableCell className="text-center">
                        {platform.status === "active" ? (
                          <Badge variant="success" className="gap-1 text-[10px] px-2 py-0.5">
                            <CheckCircle2 className="h-3 w-3" />
                            <span>启用中</span>
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1 text-[10px] px-2 py-0.5 text-muted-foreground">
                            <XCircle className="h-3 w-3" />
                            <span>已停用</span>
                          </Badge>
                        )}
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenEdit(platform)}
                            className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70 border border-border/40 hover:border-border/70 shadow-none font-normal transition-colors"
                          >
                            <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>编辑</span>
                          </Button>

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onTogglePlatformStatus(platform)}
                            className={cn(
                              "h-7 px-2 text-xs gap-1 rounded-md border border-border/40 shadow-none font-normal transition-colors",
                              platform.status === "active"
                                ? "text-muted-foreground hover:text-amber-600 hover:bg-amber-500/10 hover:border-amber-500/30"
                                : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10 hover:border-emerald-500/30"
                            )}
                          >
                            {platform.status === "active" ? (
                              <>
                                <PowerOff className="h-3.5 w-3.5 text-amber-600" />
                                <span>停用</span>
                              </>
                            ) : (
                              <>
                                <Power className="h-3.5 w-3.5 text-emerald-600" />
                                <span>启用</span>
                              </>
                            )}
                          </Button>

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenDelete(platform)}
                            className="h-7 px-2 text-xs gap-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border/40 hover:border-destructive/30 shadow-none font-normal transition-colors"
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
        </CardContent>
      </Card>

      {/* Platform Create / Edit Dialog */}
      <PlatformDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        platformToEdit={editingPlatform}
        onSubmitCreate={onCreatePlatform}
        onSubmitUpdate={onUpdatePlatform}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive mb-1">
              <Trash2 className="h-5 w-5" />
              <DialogTitle>确认删除业务平台？</DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              您确定要删除平台 <strong className="text-foreground">「{platformToDelete?.name}」</strong> 吗？
              删除后，所有桌面客户端将不再显示该平台入口。该操作不可撤销。
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteConfirmOpen(false)}
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
