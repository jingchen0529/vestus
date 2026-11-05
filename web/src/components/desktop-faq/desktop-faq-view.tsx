import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Edit2,
  FileUp,
  Loader2,
  MessageSquareText,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
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
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cloneFaqDocument, useDesktopFaq } from "@/hooks/use-desktop-faq";
import { DesktopFaqDocument, FaqItem } from "@/types/desktop-faq";
import { faqDraftsToMarkdown } from "@/types/desktop-faq-markdown";
import { FaqItemDialog } from "@/components/desktop-faq/faq-item-dialog";
import { FaqImportDialog } from "@/components/desktop-faq/faq-import-dialog";

interface FaqViewProps {
  /** 超管可编辑；普通管理员只读（渠道客服按客户所见答疑）。 */
  isSuperAdmin: boolean;
}

interface FaqRow {
  groupIndex: number;
  itemIndex: number;
  groupTitle: string;
  groupStatus: "active" | "disabled";
  item: FaqItem;
}

/**
 * 帮助内容：桌面端「常见问题」里每一条 Q&A 的列表。
 *
 * 这一页只做检索、浏览和行内快操作；新增 / 编辑一律走弹窗，分组结构在「帮助分组」页维护。
 * 保存是整篇 PUT，所以弹窗点保存即下发，没有额外的「发布」步骤。
 */
export function FaqView({ isSuperAdmin }: FaqViewProps) {
  const { loading, saving, doc, isCustomized, updatedAt, reload, commit } = useDesktopFaq();

  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<{ groupIndex: number; itemIndex: number; item: FaqItem } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FaqRow | null>(null);

  const editable = isSuperAdmin;

  const rows = useMemo<FaqRow[]>(
    () =>
      doc.groups.flatMap((group, groupIndex) =>
        group.items.map((item, itemIndex) => ({
          groupIndex,
          itemIndex,
          groupTitle: group.title,
          groupStatus: group.status,
          item,
        })),
      ),
    [doc],
  );

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchGroup = groupFilter === "ALL" || row.groupIndex === Number(groupFilter);
      const matchStatus = statusFilter === "ALL" || row.item.status === statusFilter;
      const matchKeyword =
        !keyword ||
        row.item.question.toLowerCase().includes(keyword) ||
        row.item.answer.toLowerCase().includes(keyword) ||
        row.groupTitle.toLowerCase().includes(keyword);
      return matchGroup && matchStatus && matchKeyword;
    });
  }, [rows, search, groupFilter, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const enabledCount = rows.filter((row) => row.item.status === "active").length;

  const handleOpenCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (row: FaqRow) => {
    setEditing({ groupIndex: row.groupIndex, itemIndex: row.itemIndex, item: row.item });
    setDialogOpen(true);
  };

  const handleSubmitItem = async ({ groupIndex, item }: { groupIndex: number; item: FaqItem }) => {
    const next = cloneFaqDocument(doc);
    if (editing) {
      if (editing.groupIndex === groupIndex) {
        next.groups[groupIndex].items[editing.itemIndex] = item;
      } else {
        // 改了分组：从原分组摘掉，追加到目标分组末尾。
        next.groups[editing.groupIndex].items.splice(editing.itemIndex, 1);
        next.groups[groupIndex].items.push(item);
      }
      await commit(next, "问答已更新");
      return;
    }
    next.groups[groupIndex].items.push(item);
    await commit(next, "问答已添加");
  };

  const handleToggleStatus = async (row: FaqRow) => {
    const next: DesktopFaqDocument = cloneFaqDocument(doc);
    const target = next.groups[row.groupIndex].items[row.itemIndex];
    target.status = target.status === "active" ? "disabled" : "active";
    try {
      await commit(next, target.status === "active" ? "已启用该问答" : "已停用该问答");
    } catch (error) {
      toast.error("操作失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    }
  };

  const handleMove = async (row: FaqRow, delta: number) => {
    const items = doc.groups[row.groupIndex].items;
    const target = row.itemIndex + delta;
    if (target < 0 || target >= items.length) return;
    const next = cloneFaqDocument(doc);
    const list = next.groups[row.groupIndex].items;
    [list[row.itemIndex], list[target]] = [list[target], list[row.itemIndex]];
    try {
      await commit(next, "顺序已调整");
    } catch (error) {
      toast.error("调整顺序失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    }
  };

  const handleOpenDelete = (row: FaqRow) => setDeleteTarget(row);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const next = cloneFaqDocument(doc);
    next.groups[deleteTarget.groupIndex].items.splice(deleteTarget.itemIndex, 1);
    try {
      await commit(next, "问答已删除");
      setDeleteTarget(null);
    } catch (error) {
      toast.error("删除失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    }
  };

  const handleExport = () => {
    const markdown = faqDraftsToMarkdown(doc.groups);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `帮助内容-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex h-64 w-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在加载帮助内容…
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in-50 duration-300">
      {/* 一行摘要：来源状态 + 规模 + 最近保存 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
        <Badge variant={isCustomized ? "primary" : "secondary"} className="text-[10px]">
          {isCustomized ? "自定义中" : "内置内容"}
        </Badge>
        <span className="tabular-nums">
          {doc.groups.length} 个分组 · {rows.length} 条问答 · {enabledCount} 条启用中
        </span>
        {updatedAt && <span className="tabular-nums">· 最近保存 {formatTime(updatedAt)}</span>}
        {!isCustomized && <span>· 当前展示内置内容，首次保存后转为自定义</span>}
      </div>

      <DataCard>
        <PageToolbar>
          <PageToolbarActions>
            {editable && (
              <Button size="sm" onClick={handleOpenCreate}>
                <Plus className="h-3.5 w-3.5" />
                <span>新增问答</span>
              </Button>
            )}
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <FileUp className="h-3.5 w-3.5" />
                <span>批量导入</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-3.5 w-3.5 text-muted-foreground" />
              <span>导出 Markdown</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void reload()} disabled={saving}>
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              <span>刷新</span>
            </Button>
          </PageToolbarActions>

          <PageToolbarFilters>
            <ToolbarSearch
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
              placeholder="搜索问题、答案或分组..."
            />
            <div className="w-40 shrink-0">
              <Select
                value={groupFilter}
                onValueChange={(value) => {
                  setGroupFilter(value);
                  setPage(1);
                }}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder="全部分组" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">
                    全部分组
                  </SelectItem>
                  {doc.groups.map((group, index) => (
                    <SelectItem key={`${index}-${group.title}`} value={String(index)} className="text-xs">
                      {group.title || "未命名分组"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-32 shrink-0">
              <Select
                value={statusFilter}
                onValueChange={(value) => {
                  setStatusFilter(value);
                  setPage(1);
                }}
              >
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

        {filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-muted-foreground">
            <MessageSquareText className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">没有符合条件的问答</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {search.trim() || groupFilter !== "ALL" || statusFilter !== "ALL"
                ? "换个关键词或筛选条件试试"
                : editable
                  ? "点击左上角【新增问答】添加第一条"
                  : "当前没有可展示的内容"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[46%]">问题</TableHead>
                  <TableHead className="w-[180px]">所属分组</TableHead>
                  <TableHead className="w-[100px] text-center">状态</TableHead>
                  {editable && <TableHead className="w-[280px] text-right">操作</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => (
                  <TableRow
                    key={`${row.groupIndex}-${row.itemIndex}`}
                    className="text-xs transition-colors hover:bg-muted/40"
                  >
                    <TableCell className="max-w-0">
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate font-medium text-foreground" title={row.item.question}>
                          {row.item.question}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground" title={row.item.answer}>
                          {summarize(row.item.answer)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="max-w-[170px] truncate text-[10px]">
                        {row.groupTitle}
                      </Badge>
                      {row.groupStatus === "disabled" && (
                        <span className="ml-1 text-[10px] text-warning">整组停用</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {row.item.status === "active" ? (
                        <Badge variant="success" className="text-[10px]">
                          启用中
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                          已停用
                        </Badge>
                      )}
                    </TableCell>
                    {editable && (
                      <TableCell className="whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="上移"
                            disabled={row.itemIndex === 0}
                            onClick={() => void handleMove(row, -1)}
                          >
                            <ArrowUp className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="下移"
                            disabled={row.itemIndex === doc.groups[row.groupIndex].items.length - 1}
                            onClick={() => void handleMove(row, 1)}
                          >
                            <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                          <Button variant="table-action" size="xs" onClick={() => handleOpenEdit(row)}>
                            <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>编辑</span>
                          </Button>
                          <Button
                            variant="table-action"
                            size="xs"
                            onClick={() => void handleToggleStatus(row)}
                            className={
                              row.item.status === "active"
                                ? "hover:bg-warning/10 hover:text-warning"
                                : "hover:bg-success/10 hover:text-success"
                            }
                          >
                            {row.item.status === "active" ? (
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
                            onClick={() => handleOpenDelete(row)}
                            className="hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            <span>删除</span>
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {filtered.length > 0 && (
          <TablePagination
            currentPage={safePage}
            totalPages={pageCount}
            totalItems={filtered.length}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            disabled={saving}
          />
        )}
      </DataCard>

      {editable && (
        <>
          <FaqItemDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            groups={doc.groups}
            editing={editing}
            defaultGroupIndex={groupFilter === "ALL" ? 0 : Number(groupFilter)}
            saving={saving}
            onSubmit={handleSubmitItem}
          />
          <FaqImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            doc={doc}
            saving={saving}
            onImport={commit}
          />
        </>
      )}

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-2 text-destructive">
              <Trash2 className="h-4 w-4 shrink-0" />
              <DialogTitle>确认删除这条问答？</DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              将删除「<strong className="text-foreground">{deleteTarget?.item.question}</strong>」，
              桌面端「常见问题」里不再展示。该操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteTarget(null)}
              disabled={saving}
              className="text-xs"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmDelete()}
              loading={saving}
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

function summarize(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

function formatTime(value: string): string {
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
