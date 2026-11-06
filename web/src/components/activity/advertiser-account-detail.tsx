import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TablePagination } from "@/components/ui/table-pagination";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { SessionDetailModal } from "./session-detail-modal";
import type { BrowserSessionDetail } from "@/types/browser-activity";
import type { AdvertiserAccountItem, AdvertiserAccountQuery, AdvertiserPage } from "@/types/advertiser-account";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBeijingDateTime } from "@/lib/utils";
import type { AdvertiserAssociation, AdvertiserIdentitySource, AdvertiserSource } from "@/types/advertiser-account";

const identityLabels: Record<AdvertiserIdentitySource, string> = {
  bootstrap: "启动时身份", historical: "历史关联", unassociated: "未关联",
};

export function AdvertiserAssociationsTable({ items }: { items: AdvertiserAssociation[] }) {
  if (!items.length) return <p className="p-4 text-sm text-muted-foreground">暂无关联记录</p>;
  return <Table><TableHeader><TableRow>
    {["巨量账号 / 远端身份", "身份来源", "凭据版本", "用户 / 会话", "首次 / 末次发现"].map(label => <TableHead key={label}>{label}</TableHead>)}
  </TableRow></TableHeader><TableBody>{items.map((item, index) => <TableRow key={`${item.managedAccountId}:${item.remoteAccountId}:${item.identitySource}:${index}`}>
    <TableCell><div>{item.managedAccountName || "未关联"}</div><div className="text-xs text-muted-foreground">{item.remoteDisplayName || "—"} · {item.remoteAccountId || "—"}</div></TableCell>
    <TableCell>{identityLabels[item.identitySource]}</TableCell><TableCell>{item.credentialVersion ?? "—"}</TableCell>
    <TableCell>{item.userCount} 位用户 / {item.sessionCount} 次会话</TableCell>
    <TableCell className="text-xs whitespace-nowrap"><div>{formatBeijingDateTime(item.firstSeenAt)}</div><div>{formatBeijingDateTime(item.lastSeenAt)}</div></TableCell>
  </TableRow>)}</TableBody></Table>;
}

export function AdvertiserSourcesTable({ items, onOpenSession, opening = false }: {
  items: AdvertiserSource[];
  onOpenSession: (id: number) => void;
  opening?: boolean;
}) {
  if (!items.length) return <p className="p-4 text-sm text-muted-foreground">暂无来源页面</p>;
  return <Table><TableHeader><TableRow>
    {["来源页面 / 查询参数", "用户 / 巨量账号", "身份来源", "首次 / 末次发现", "访问 / 点击 / 输入 / 提交", "会话"].map(label => <TableHead key={label}>{label}</TableHead>)}
  </TableRow></TableHeader><TableBody>{items.map(item => <TableRow key={item.pageId}>
    <TableCell className="max-w-md"><div className="text-xs text-muted-foreground">页面 #{item.pageId}</div><div className="break-all text-xs">{item.url}</div><pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all text-xs">{item.urlParams || "无查询参数"}</pre></TableCell>
    <TableCell>{item.username}<div className="text-xs text-muted-foreground">{item.managedAccountName || "未关联"}{item.remoteAccountId ? ` · ${item.remoteAccountId}` : ""}</div></TableCell>
    <TableCell>{identityLabels[item.identitySource]}</TableCell>
    <TableCell className="whitespace-nowrap text-xs"><div>{formatBeijingDateTime(item.firstSeenAt)}</div><div>{formatBeijingDateTime(item.lastSeenAt)}</div></TableCell>
    <TableCell>{item.visits} / {item.clicks} / {item.inputs} / {item.submits}</TableCell>
    <TableCell><Button variant="outline" size="sm" disabled={opening} onClick={() => onOpenSession(item.sessionId)}>打开会话 #{item.sessionId}</Button></TableCell>
  </TableRow>)}</TableBody></Table>;
}

export function AdvertiserAccountDetail({ account, query, onClose, onLoadDetail }: {
  account: AdvertiserAccountItem;
  query: AdvertiserAccountQuery;
  onClose: () => void;
  onLoadDetail: (id: number) => Promise<BrowserSessionDetail>;
}) {
  const [associationPage, setAssociationPage] = useState(1);
  const [sourcePage, setSourcePage] = useState(1);
  const [associationSize, setAssociationSize] = useState(10);
  const [sourceSize, setSourceSize] = useState(10);
  const [revision, setRevision] = useState(0);
  const [associations, setAssociations] = useState<{ key: string; data?: AdvertiserPage<AdvertiserAssociation>; error?: string } | null>(null);
  const [sources, setSources] = useState<{ key: string; data?: AdvertiserPage<AdvertiserSource>; error?: string } | null>(null);
  const [session, setSession] = useState<BrowserSessionDetail | null>(null);
  const [opening, setOpening] = useState(false);
  const sessionSeq = useRef(0);
  const baseKey = JSON.stringify([account.platformId, account.advertiserId, query, revision]);
  const associationKey = `${baseKey}:${associationPage}:${associationSize}`;
  const sourceKey = `${baseKey}:${sourcePage}:${sourceSize}`;
  const currentAssociations = associations?.key === associationKey ? associations : null;
  const currentSources = sources?.key === sourceKey ? sources : null;

  useEffect(() => {
    let active = true;
    api.listAdvertiserAssociations(account.platformId, account.advertiserId, { ...query, page: associationPage, pageSize: associationSize }).then(data => {
      if (active) setAssociations({ key: associationKey, data });
    }).catch(error => {
      if (active) setAssociations({ key: associationKey, error: error instanceof Error ? error.message : "加载关联失败" });
    });
    return () => { active = false; };
  }, [associationKey]);

  useEffect(() => {
    let active = true;
    api.listAdvertiserSources(account.platformId, account.advertiserId, { ...query, page: sourcePage, pageSize: sourceSize }).then(data => {
      if (active) setSources({ key: sourceKey, data });
    }).catch(error => {
      if (active) setSources({ key: sourceKey, error: error instanceof Error ? error.message : "加载来源失败" });
    });
    return () => { active = false; };
  }, [sourceKey]);

  useEffect(() => () => { sessionSeq.current += 1; }, []);

  const openSession = async (id: number) => {
    const seq = ++sessionSeq.current;
    setOpening(true);
    try {
      // Fetch the actual session, not a guessed list row or a page from the 1000-page capped modal.
      const loaded = await onLoadDetail(id);
      if (seq === sessionSeq.current) setSession(loaded);
    } catch (error) {
      if (seq === sessionSeq.current) toast.error("加载会话失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      if (seq === sessionSeq.current) setOpening(false);
    }
  };

  return <>
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="w-[96vw] sm:max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="break-all">广告账户 {account.advertiserId}</DialogTitle><DialogDescription>仅访问关联，不代表归属/投放成功；时间与页面记录区间相交，累计计数不是精确日内。来源参数独立保留，不受会话详情页面数量上限影响。</DialogDescription></DialogHeader>
        <div className="flex justify-between items-center"><span className="text-sm">{account.platformName || `平台 #${account.platformId}`}</span><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>刷新详情</Button></div>
        <section className="rounded border overflow-hidden"><h3 className="px-4 py-3 text-sm font-medium">关联账号</h3>
          {!currentAssociations ? <p role="status" className="p-4 text-sm">加载关联记录…</p> : currentAssociations.error ? <p role="alert" className="p-4 text-sm text-destructive">{currentAssociations.error}</p> : <AdvertiserAssociationsTable items={currentAssociations.data?.items || []} />}
          <TablePagination currentPage={associationPage} pageSize={associationSize} totalPages={currentAssociations?.data?.pages || 1} totalItems={currentAssociations?.data?.total || 0} onPageChange={setAssociationPage} onPageSizeChange={size => { setAssociationSize(size); setAssociationPage(1); }} disabled={!currentAssociations} />
        </section>
        <section className="rounded border overflow-hidden"><h3 className="px-4 py-3 text-sm font-medium">来源页面</h3>
          {!currentSources ? <p role="status" className="p-4 text-sm">加载来源页面…</p> : currentSources.error ? <p role="alert" className="p-4 text-sm text-destructive">{currentSources.error}</p> : <AdvertiserSourcesTable items={currentSources.data?.items || []} onOpenSession={id => void openSession(id)} opening={opening} />}
          <TablePagination currentPage={sourcePage} pageSize={sourceSize} totalPages={currentSources?.data?.pages || 1} totalItems={currentSources?.data?.total || 0} onPageChange={setSourcePage} onPageSizeChange={size => { setSourceSize(size); setSourcePage(1); }} disabled={!currentSources} />
        </section>
      </DialogContent>
    </Dialog>
    {session && <SessionDetailModal open session={session} onOpenChange={open => { if (!open) setSession(null); }} onLoadDetail={onLoadDetail} />}
  </>;
}
