import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  BrowserPageVisitItem,
  BrowserSessionDetail,
  BrowserSessionItem,
} from "@/types/browser-activity";
import { formatDate, formatDuration, cn } from "@/lib/utils";
import { Activity, AlertTriangle, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface SessionDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 列表里那一行。地址明细要另外拉，这里先用它把摘要画出来。 */
  session: BrowserSessionItem | null;
  onLoadDetail: (id: number) => Promise<BrowserSessionDetail>;
  onRefreshSessions?: () => void;
}

const PAGE_SIZE = 10;

interface PageActivityMetaProps {
  pageItem: BrowserPageVisitItem;
}

function hasSnapshotValues(snapshot?: Record<string, string[]> | null) {
  return Boolean(snapshot && Object.values(snapshot).some((values) => values.length > 0));
}

function SnapshotBlock({
  title,
  snapshot,
  capturedAt,
}: {
  title: string;
  snapshot?: Record<string, string[]> | null;
  capturedAt?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!hasSnapshotValues(snapshot)) return null;

  return (
    <details
      className="mt-1.5 rounded border border-border/70 bg-muted/20 px-2 py-1.5"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        {title}
        {capturedAt ? ` · ${formatDate(capturedAt)}` : ""}
      </summary>
      {expanded && (
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-foreground">
          {JSON.stringify(snapshot, null, 2)}
        </pre>
      )}
    </details>
  );
}

/** 地址相关的附加数据保持在地址单元格内，避免给会话表增加横向列。 */
export function PageActivityMeta({ pageItem }: PageActivityMetaProps) {
  const urlParams = pageItem.urlParams?.trim();
  const hasParams = Boolean(urlParams);
  const hasSnapshots = hasSnapshotValues(pageItem.inputSnapshot) || hasSnapshotValues(pageItem.submitSnapshot);

  if (!hasParams && !hasSnapshots) return null;

  return (
    <div className="mt-1.5 space-y-1.5 text-[10px]">
      {hasParams && (
        <div>
          <span className="text-muted-foreground">地址参数</span>
          <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-foreground">
            {urlParams}
          </pre>
        </div>
      )}
      <SnapshotBlock
        title="客户输入快照"
        snapshot={pageItem.inputSnapshot}
        capturedAt={pageItem.inputSnapshotAt}
      />
      <SnapshotBlock
        title="提交内容快照"
        snapshot={pageItem.submitSnapshot}
        capturedAt={pageItem.submitSnapshotAt}
      />
    </div>
  );
}

export function PageAddress({ pageItem }: PageActivityMetaProps) {
  return (
    <>
      <div>{pageItem.url}</div>
      <PageActivityMeta pageItem={pageItem} />
    </>
  );
}

export function SessionDetailModal({
  open,
  onOpenChange,
  session,
  onLoadDetail,
  onRefreshSessions,
}: SessionDetailModalProps) {
  const [detail, setDetail] = useState<BrowserSessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // 走 ref 读取加载函数：调用方传个内联箭头函数也不会把这个 effect 变成取数死循环。
  const loadRef = useRef(onLoadDetail);
  loadRef.current = onLoadDetail;

  const sessionId = session?.id ?? null;

  const fetchDetail = useCallback(async (isManual = false) => {
    if (sessionId === null) return;
    if (isManual) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);
    try {
      const loaded = await loadRef.current(sessionId);
      setDetail(loaded);
      if (isManual) {
        if (onRefreshSessions) {
          onRefreshSessions();
        }
        toast.success("会话明细与数据已刷新");
      }
    } catch (err: any) {
      setError(err?.message || "读取地址明细失败");
      if (isManual) {
        toast.error("刷新失败", { description: err?.message || "请稍后重试" });
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [sessionId, onRefreshSessions]);

  useEffect(() => {
    if (!open || sessionId === null) return;
    let abandoned = false;

    // 换行之后先清掉上一行的详情，否则加载期间概要显示的还是上一个会话。
    setDetail(null);
    setPage(1);
    setIsLoading(true);
    setError(null);
    loadRef
      .current(sessionId)
      .then((loaded) => {
        // 弹窗已经关掉、或者换了一行，就把这次结果丢掉，别覆盖新的。
        if (!abandoned) setDetail(loaded);
      })
      .catch((err: any) => {
        if (!abandoned) setError(err?.message || "读取地址明细失败");
      })
      .finally(() => {
        if (!abandoned) setIsLoading(false);
      });

    return () => {
      abandoned = true;
    };
  }, [open, sessionId]);

  // 摘要优先用详情里的数字：它和地址明细来自同一次查询，彼此对得上。
  const summary = detail ?? session;
  const rawPages = detail?.pages ?? [];

  // 按时间倒序排
  const sortedPages = useMemo(() => {
    return [...rawPages].sort((a, b) => {
      const timeA = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const timeB = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return b.id - a.id;
    });
  }, [rawPages]);

  // 分页：一页固定 10 条
  const totalPages = Math.ceil(sortedPages.length / PAGE_SIZE) || 1;
  const paginatedPages = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return sortedPages.slice(start, start + PAGE_SIZE);
  }, [sortedPages, page]);

  if (!session || !summary) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl md:max-w-6xl w-[94vw] h-[85vh] max-h-[85vh] flex flex-col p-6 overflow-hidden">
        <DialogHeader className="shrink-0 mb-2">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <DialogTitle className="text-base font-semibold">浏览器会话详情 #{session.id}</DialogTitle>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchDetail(true)}
              disabled={isLoading || isRefreshing}
              className="h-7 text-xs gap-1.5 px-2.5 text-muted-foreground hover:text-foreground border border-border/60 hover:bg-muted/60 rounded-md shadow-none font-normal"
              title="点击刷新会话明细并同步刷新外部列表"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", (isLoading || isRefreshing) && "animate-spin text-primary")} />
              <span>{isRefreshing ? "刷新中…" : "刷新"}</span>
            </Button>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            桌面端上报的会话汇总与访问地址明细，地址只保留路径、不含查询参数
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1 text-xs">
          {/* 概要 */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2 flex-wrap">
              {summary.directMode ? (
                <Badge variant="warning" className="text-xs">直连</Badge>
              ) : (
                <Badge variant="success" className="text-xs">代理</Badge>
              )}
              {summary.clientVersion ? (
                <Badge variant="outline" className="text-xs font-mono text-primary bg-primary/5 border-primary/30">
                  客户端 v{summary.clientVersion.replace(/^desktop-/, "").replace(/^v/, "")}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs font-mono text-muted-foreground border-border/70" title="该历史会话产生于未上报版本的客户端">
                  客户端 v0.1.8 (历史版本)
                </Badge>
              )}
              <span className="font-semibold text-foreground text-sm">
                {summary.username || `#${summary.userId}`}
                <span className="text-muted-foreground font-normal ml-1.5">
                  @ {summary.platformName || `平台 #${summary.platformId}`}
                </span>
              </span>
            </div>
            <span className="text-muted-foreground">{formatDate(summary.startedAt)}</span>
          </div>

          {/* 关键字段 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-lg border">
            <div>
              <span className="text-muted-foreground block mb-0.5">客户端版本</span>
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-semibold text-foreground">
                  {summary.clientVersion ? `v${summary.clientVersion.replace(/^desktop-/, "").replace(/^v/, "")}` : "v0.1.8"}
                </span>
                {!summary.clientVersion && (
                  <span className="text-[10px] text-muted-foreground font-normal">
                    (旧版默认)
                  </span>
                )}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground block mb-0.5">访问地址数</span>
              <span className="font-semibold text-foreground">{summary.pageCount}</span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-0.5">前台停留</span>
              <span className="font-semibold text-foreground">{formatDuration(summary.dwellMs)}</span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-0.5">最近上报</span>
              <span className="font-mono text-foreground">{formatDate(summary.lastReportAt)}</span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-0.5">客户端 IP</span>
              <span className="font-mono text-foreground">{summary.ipAddress || "—"}</span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-0.5">交互次数</span>
              <span className="text-foreground">
                访问 {summary.visits} · 点击 {summary.clicks}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-0.5">输入与提交</span>
              <span className="text-foreground">
                输入 {summary.inputs} · 提交 {summary.submits} · 滚动 {summary.scrolls}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-0.5">浏览器实例</span>
              <span className="font-mono text-foreground">#{summary.browserId}</span>
            </div>
            <div className="col-span-2 sm:col-span-4">
              <span className="text-muted-foreground block mb-0.5">会话唯一标识</span>
              <span
                className="font-mono text-foreground text-[11px] break-all block select-all bg-muted/40 p-1.5 rounded border border-border/50"
                title={summary.sessionKey}
              >
                {summary.sessionKey}
              </span>
            </div>
          </div>

          {summary.droppedPages > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                客户端聚合表溢出，另有 <strong>{summary.droppedPages}</strong> 个地址未被记录，
                下面的列表并不完整。
              </span>
            </div>
          )}

          {/* 地址明细 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground block">
                访问地址明细
                <span className="text-muted-foreground font-normal ml-2">
                  (按时间倒序排列)
                </span>
              </span>
            </div>

            {isLoading && (
              <div className="flex items-center justify-center gap-2 p-8 rounded-lg border text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span>正在读取地址明细...</span>
              </div>
            )}

            {!isLoading && error && (
              <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
                {error}
              </div>
            )}

            {!isLoading && !error && sortedPages.length === 0 && (
              <div className="p-6 rounded-lg border text-center text-muted-foreground">
                这次会话没有记录到任何地址
              </div>
            )}

            {!isLoading && !error && sortedPages.length > 0 && (
              <div className="rounded-lg border overflow-hidden bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[360px]">访问地址</TableHead>
                      <TableHead className="w-[70px] text-right whitespace-nowrap">访问</TableHead>
                      <TableHead className="w-[70px] text-right whitespace-nowrap">点击</TableHead>
                      <TableHead className="w-[70px] text-right whitespace-nowrap">输入</TableHead>
                      <TableHead className="w-[70px] text-right whitespace-nowrap">提交</TableHead>
                      <TableHead className="w-[100px] text-right whitespace-nowrap">停留</TableHead>
                      <TableHead className="w-[170px] whitespace-nowrap">最近访问</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedPages.map((pageItem) => (
                      <TableRow key={pageItem.id} className="text-[11px] hover:bg-muted/30">
                        <TableCell
                          className="font-mono text-foreground break-all py-2.5 leading-relaxed"
                          title={pageItem.url}
                        >
                          <PageAddress pageItem={pageItem} />
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">{pageItem.visits}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{pageItem.clicks}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{pageItem.inputs}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{pageItem.submits}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {formatDuration(pageItem.dwellMs)}
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                          {formatDate(pageItem.lastSeenAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* 分页控制栏 */}
                <div className="flex items-center justify-between px-3 py-2.5 border-t bg-muted/20 text-xs text-muted-foreground">
                  <div>
                    共 <strong className="text-foreground">{sortedPages.length}</strong> 条记录 · 每页 {PAGE_SIZE} 条
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="mr-1">
                      第 <strong className="text-foreground">{page}</strong> / {totalPages} 页
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="h-7 px-2 text-xs rounded-md border-border/60 bg-background hover:bg-muted text-foreground gap-1 font-normal shadow-none disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      <span>上一页</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      className="h-7 px-2 text-xs rounded-md border-border/60 bg-background hover:bg-muted text-foreground gap-1 font-normal shadow-none disabled:opacity-40"
                    >
                      <span>下一页</span>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
