import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { api } from "@/lib/api-client";
import { formatBeijingDateTime } from "@/lib/utils";
import type { BrowserSessionDetail, BrowserSessionItem } from "@/types/browser-activity";
import type { AdvertiserAccountItem, AdvertiserPage } from "@/types/advertiser-account";
import { AdvertiserAccountDetail } from "./advertiser-account-detail";

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast.success("广告账户 ID 已复制");
  } catch {
    toast.error("复制失败，请手动选择 ID 复制");
  }
}

export function SessionAdvertiserTable({ items, onSelect }: {
  items: AdvertiserAccountItem[];
  onSelect: (item: AdvertiserAccountItem) => void;
}) {
  if (!items.length) {
    return <p className="py-10 text-center text-sm text-muted-foreground">本次会话尚未记录到广告账户</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>广告账户 ID</TableHead>
          <TableHead className="text-right">访问次数</TableHead>
          <TableHead>最近访问</TableHead>
          <TableHead className="text-right">来源</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map(item => (
          <TableRow key={`${item.platformId}:${item.advertiserId}`}>
            <TableCell>
              <div className="flex items-center gap-1">
                <span className="break-all font-mono text-xs">{item.advertiserId}</span>
                <Button variant="ghost" size="icon-sm" aria-label={`复制广告账户 ID ${item.advertiserId}`} onClick={() => void copyId(item.advertiserId)}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">{item.totalVisits}</TableCell>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatBeijingDateTime(item.lastSeenAt)}</TableCell>
            <TableCell className="text-right">
              <Button variant="table-action" size="xs" onClick={() => onSelect(item)}>查看来源</Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SessionAdvertiserDialog({ session, onClose, onLoadDetail }: {
  session: BrowserSessionItem;
  onClose: () => void;
  onLoadDetail: (id: number) => Promise<BrowserSessionDetail>;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: AdvertiserPage<AdvertiserAccountItem>; error?: string } | null>(null);
  const [selected, setSelected] = useState<AdvertiserAccountItem | null>(null);
  const requestKey = `${session.id}:${page}:${pageSize}:${revision}`;
  const current = result?.key === requestKey ? result : null;

  useEffect(() => {
    let active = true;
    api.listAdvertiserAccounts({ sessionId: session.id, page, pageSize }).then(data => {
      if (active) setResult({ key: requestKey, data });
    }).catch(error => {
      if (active) setResult({ key: requestKey, error: error instanceof Error ? error.message : "加载广告账户失败" });
    });
    return () => { active = false; };
  }, [session.id, page, pageSize, requestKey]);

  return <>
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>广告账户列表</DialogTitle>
          <DialogDescription>
            {session.username} · {session.platformName || `平台 #${session.platformId}`} · {session.managedAccountName || "未关联巨量账号"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>仅本次会话 #{session.id} 的访问记录，不代表广告操作成功。</span>
          <Button variant="outline" size="sm" disabled={!current} onClick={() => setRevision(value => value + 1)}>刷新</Button>
        </div>
        {!current ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">加载广告账户…</p>
          : current.error ? <p role="alert" className="py-10 text-center text-sm text-destructive">{current.error}</p>
            : <SessionAdvertiserTable items={current.data?.items || []} onSelect={setSelected} />}
        {session.droppedPages > 0 && <p className="text-xs text-muted-foreground">本次会话有未采集页面，广告账户列表可能不完整。</p>}
        <TablePagination currentPage={page} pageSize={pageSize} totalPages={current?.data?.pages || 1}
          totalItems={current?.data?.total || 0} onPageChange={setPage}
          onPageSizeChange={size => { setPageSize(size); setPage(1); }} disabled={!current} />
      </DialogContent>
    </Dialog>
    {selected && <AdvertiserAccountDetail key={`${session.id}:${selected.advertiserId}`} account={selected}
      query={{ sessionId: session.id }} onClose={() => setSelected(null)} onLoadDetail={onLoadDetail} />}
  </>;
}
