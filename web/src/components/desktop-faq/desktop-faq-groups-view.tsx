import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit2,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataCard,
  PageToolbar,
  PageToolbarActions,
  PageToolbarFilters,
  ToolbarSearch,
} from "@/components/ui/page-toolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { cloneFaqDocument, useDesktopFaq } from "@/hooks/use-desktop-faq";
import { FaqStatus } from "@/types/desktop-faq";
import { FaqGroupDialog } from "@/components/desktop-faq/faq-group-dialog";

/**
 * 帮助分组：客户端「常见问题」里的栏目本身（标题、顺序、启用状态）。
 * 问答内容不在这一页增删，只显示条数——点「编辑」改的是栏目属性。
 */
export function FaqGroupsView() {
  const { loading, saving, doc, isCustomized, updatedAt, reload, commit, reset } = useDesktopFaq();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const rows = useMemo(
    () =>
      doc.groups
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => {
          const keyword = search.trim().toLowerCase();
          const matchKeyword = !keyword || group.title.toLowerCase().includes(keyword);
          const matchStatus = statusFilter === "ALL" || group.status === statusFilter;
          return matchKeyword && matchStatus;
        }),
    [doc, search, statusFilter],
  );

  const totalItems = doc.groups.reduce((sum, group) => sum + group.items.length, 0);
  const editingGroup = editingIndex === null ? null : doc.groups[editingIndex];

  const handleSubmitGroup = async (value: { title: string; status: FaqStatus }) => {
    const next = cloneFaqDocument(doc);
    if (editingIndex !== null) {
      next.groups[editingIndex] = { ...next.groups[editingIndex], ...value };
      await commit(next, "分组已更新");
      return;
    }
    next.groups.push({ title: value.title, status: value.status, items: [] });
    await commit(next, "分组已添加");
  };

  const handleMove = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= doc.groups.length) return;
    const next = cloneFaqDocument(doc);
    [next.groups[index], next.groups[target]] = [next.groups[target], next.groups[index]];
    try {
      await commit(next, "分组顺序已调整");
    } catch (error) {
      toast.error("调整顺序失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    }
  };

  const handleDelete = async () => {
    if (deleteIndex === null) return;
    if (doc.groups.length <= 1) {
      toast.error("至少保留一个分组", { description: "要下线全部内容，请使用「恢复默认」" });
      setDeleteIndex(null);
      return;
    }
    const next = cloneFaqDocument(doc);
    next.groups.splice(deleteIndex, 1);
    try {
      await commit(next, "分组已删除");
      setDeleteIndex(null);
    } catch (error) {
      toast.error("删除失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    }
  };

  const handleReset = async () => {
    try {
      await reset();
      setResetOpen(false);
    } catch (error) {
      toast.error("恢复默认失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 w-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在加载帮助分组…
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in-50 duration-300">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
        <Badge variant={isCustomized ? "primary" : "secondary"} className="text-[10px]">
          {isCustomized ? "自定义中" : "内置内容"}
        </Badge>
        <span className="tabular-nums">
          {doc.groups.length} 个分组 · {totalItems} 条问答
        </span>
        {updatedAt && <span className="tabular-nums">· 最近保存 {formatTime(updatedAt)}</span>}
        <span>· 分组顺序即客户端里的栏目顺序</span>
      </div>

      <DataCard>
        <PageToolbar>
          <PageToolbarActions>
            <Button
              size="sm"
              onClick={() => {
                setEditingIndex(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>新增分组</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)} disabled={saving}>
              <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
              <span>恢复默认</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void reload()} disabled={saving}>
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              <span>刷新</span>
            </Button>
          </PageToolbarActions>

          <PageToolbarFilters>
            <ToolbarSearch value={search} onChange={setSearch} placeholder="搜索分组标题..." />
            <div className="w-32 shrink-0">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">
                    全部状态
                  </SelectItem>
                  <SelectItem value="active" className="text-xs">
                    仅启用
                  </SelectItem>
                  <SelectItem value="disabled" className="text-xs">
                    仅停用
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PageToolbarFilters>
        </PageToolbar>

        {rows.length === 0 ? (
          <div className="px-6 py-16 text-center text-muted-foreground">
            <Layers className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">没有符合条件的分组</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {search.trim() || statusFilter !== "ALL"
                ? "换个关键词或筛选条件试试"
                : "点击左上角【新增分组】建立第一个栏目"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px] text-center">排序</TableHead>
                  <TableHead className="min-w-[260px]">分组标题</TableHead>
                  <TableHead className="w-[120px] text-center">问答数</TableHead>
                  <TableHead className="w-[110px] text-center">状态</TableHead>
                  <TableHead className="w-[280px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ group, index }) => (
                  <TableRow key={`${index}-${group.title}`} className="text-xs transition-colors hover:bg-muted/40">
                    <TableCell className="text-center font-mono text-[11px] text-muted-foreground">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <p className="truncate font-medium text-foreground" title={group.title}>
                        {group.title}
                      </p>
                      {group.items.length === 0 && (
                        <p className="text-[10px] text-warning">还没有问答，客户端暂不展示</p>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <span
                        className={cn(
                          "tabular-nums",
                          group.items.length === 0 ? "text-muted-foreground/60" : "text-foreground",
                        )}
                      >
                        {group.items.length}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      {group.status === "active" ? (
                        <Badge variant="success" className="text-[10px]">
                          启用中
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                          已停用
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="上移"
                          disabled={index === 0}
                          onClick={() => void handleMove(index, -1)}
                        >
                          <ArrowUp className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="下移"
                          disabled={index === doc.groups.length - 1}
                          onClick={() => void handleMove(index, 1)}
                        >
                          <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => {
                            setEditingIndex(index);
                            setDialogOpen(true);
                          }}
                        >
                          <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>编辑</span>
                        </Button>
                        <Button
                          variant="table-action"
                          size="xs"
                          onClick={() => setDeleteIndex(index)}
                          className="hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
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

      <FaqGroupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={
          editingGroup
            ? {
                title: editingGroup.title,
                status: editingGroup.status,
                itemCount: editingGroup.items.length,
              }
            : null
        }
        saving={saving}
        onSubmit={handleSubmitGroup}
      />

      <Dialog open={deleteIndex !== null} onOpenChange={(open) => !open && setDeleteIndex(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-2 text-destructive">
              <Trash2 className="h-4 w-4 shrink-0" />
              <DialogTitle>确认删除这个分组？</DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              删除「<strong className="text-foreground">{deleteIndex !== null ? doc.groups[deleteIndex]?.title : ""}</strong>
              」会连同它下面的{" "}
              <strong className="text-foreground">{deleteIndex !== null ? doc.groups[deleteIndex]?.items.length : 0}</strong>{" "}
              条问答一起移除，该操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteIndex(null)}
              disabled={saving}
              className="text-xs"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
              loading={saving}
              className="text-xs font-semibold"
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>恢复默认帮助内容？</DialogTitle>
            <DialogDescription className="text-xs">
              将清空后台自定义的全部分组和问答，客户端「常见问题」回退为随版本内置的内容。该操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleReset()}
              loading={saving}
              className="text-xs font-semibold"
            >
              确认恢复默认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
