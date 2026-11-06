import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageToolbar, PageToolbarActions } from "@/components/ui/page-toolbar";
import { TablePagination } from "@/components/ui/table-pagination";
import { api } from "@/lib/api-client";
import { exportToCsvFile } from "@/lib/export-utils";
import { beijingDateStamp } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import type { DesktopUser } from "@/types/user";
import type { PlatformItem } from "@/types/platform";
import type { BrowserSessionDetail } from "@/types/browser-activity";
import { EMPTY_ADVERTISER_FILTERS, toAdvertiserAccountQuery } from "@/types/advertiser-account";
import type { AdvertiserAccountFilters, AdvertiserAccountOptions, AdvertiserPage } from "@/types/advertiser-account";
import { AdvertiserAccountDetail } from "./advertiser-account-detail";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { formatBeijingDateTime } from "@/lib/utils";
import type { AdvertiserAccountItem } from "@/types/advertiser-account";

export const ADVERTISER_ACCESS_NOTICE = "仅访问关联，不代表归属/投放成功；时间与页面记录区间相交，累计计数不是精确日内。时间均为北京时间。";

type NamedOption = { id: number; name: string };

const EMPTY_OPTIONS: AdvertiserAccountOptions = {
  platforms: [], managedAccounts: [], page: 0, pageSize: 100,
  managedAccountsHasMore: false, platformsHasMore: false,
};

export function mergeAdvertiserOptionPage(previous: AdvertiserAccountOptions, next: AdvertiserAccountOptions): AdvertiserAccountOptions {
  const merge = (before: NamedOption[], after: NamedOption[]) => Array.from(new Map([...before, ...after].map(item => [item.id, item])).values());
  return {
    ...next,
    managedAccounts: merge(next.page === 1 ? [] : previous.managedAccounts, next.managedAccounts),
    platforms: merge(next.page === 1 ? [] : previous.platforms, next.platforms),
  };
}

export function AdvertiserOptionsSearch({ search, options, loading = false, error, onSearch, onLoadMore, onRetry }: {
  search: string;
  options: Pick<AdvertiserAccountOptions, "managedAccountsHasMore" | "platformsHasMore">;
  loading?: boolean;
  error?: string | null;
  onSearch: (value: string) => void;
  onLoadMore: () => void;
  onRetry?: () => void;
}) {
  return <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b">
    <Input className="h-8 w-56 text-xs" aria-label="筛选项搜索" placeholder="筛选项搜索" value={search} onChange={event => onSearch(event.target.value)} />
    <span className="text-xs text-muted-foreground">仅搜索平台/巨量账号名称或 ID，不改变广告记录筛选。</span>
    {loading && <span role="status" className="text-xs text-muted-foreground">加载筛选项…</span>}
    {(options.managedAccountsHasMore || options.platformsHasMore) && <Button variant="outline" size="sm" disabled={loading || Boolean(error)} onClick={onLoadMore}>加载更多筛选项</Button>}
    {error && <><span role="alert" className="text-xs text-destructive">筛选项加载失败：{error}</span><Button variant="outline" size="sm" disabled={loading} onClick={onRetry}>重试筛选项</Button></>}
  </div>;
}

function FilterSelect({ label, value, items, onChange }: {
  label: string; value: string; items: NamedOption[]; onChange: (value: string) => void;
}) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger size="sm" className="w-40" aria-label={label}><SelectValue placeholder={label} /></SelectTrigger><SelectContent>
    <SelectItem value="ALL">全部{label}</SelectItem>
    {items.map(item => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}
  </SelectContent></Select>;
}

export function AdvertiserAccountFiltersBar({ filters, users, platforms, managedAccounts, onChange }: {
  filters: AdvertiserAccountFilters;
  users: Pick<DesktopUser, "id" | "username">[];
  platforms: NamedOption[];
  managedAccounts: NamedOption[];
  onChange: (filters: AdvertiserAccountFilters) => void;
}) {
  const patch = (value: Partial<AdvertiserAccountFilters>) => onChange({ ...filters, ...value });
  return <div className="flex flex-wrap gap-2 border-b px-4 py-3">
    <Input className="h-8 w-56 text-xs" aria-label="广告 ID 子串" placeholder="广告 ID 子串（保留前导零）" value={filters.advertiserId} onChange={event => patch({ advertiserId: event.target.value })} />
    <FilterSelect label="桌面用户" value={filters.userId} items={users.map(user => ({ id: user.id, name: user.username }))} onChange={userId => patch({ userId })} />
    <FilterSelect label="平台" value={filters.platformId} items={platforms} onChange={platformId => patch({ platformId })} />
    <FilterSelect label="巨量账号" value={filters.managedAccountId} items={managedAccounts} onChange={managedAccountId => patch({ managedAccountId })} />
    <Select value={filters.connection} onValueChange={connection => patch({ connection: connection as AdvertiserAccountFilters["connection"] })}><SelectTrigger size="sm" className="w-32" aria-label="连接方式"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部连接方式</SelectItem><SelectItem value="DIRECT">直连</SelectItem><SelectItem value="PROXY">代理</SelectItem></SelectContent></Select>
    <div className="w-36"><DatePicker size="sm" value={filters.startAt} max={filters.endAt || undefined} placeholder="起始日期" title="与页面记录区间相交：起始日期" onChange={startAt => patch({ startAt })} /></div>
    <div className="w-36"><DatePicker size="sm" value={filters.endAt} min={filters.startAt || undefined} placeholder="结束日期" title="与页面记录区间相交：结束日期（含当天）" onChange={endAt => patch({ endAt })} /></div>
    <Button variant="outline" size="sm" onClick={() => onChange({ ...EMPTY_ADVERTISER_FILTERS })}>重置</Button>
  </div>;
}

export function advertiserAssociationLabel(item: AdvertiserAccountItem): string {
  if (!item.managedAccountCount) return "未关联";
  return item.unassociatedSessionCount > 0 ? "部分未关联" : "关联";
}

function safeCsvText(value: string): string {
  return /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value;
}

export const advertiserCsvHeaders = [
  { label: "广告 ID（文本）", key: "advertiserId" }, { label: "平台", key: "platformName" },
  { label: "巨量账号摘要（最多 3 个）", key: "managedAccountNames" }, { label: "账号数", key: "managedAccountCount" },
  { label: "用户名摘要（最多 3 个）", key: "usernames" }, { label: "用户数", key: "userCount" },
  { label: "会话数", key: "sessionCount" }, { label: "页面数", key: "pageCount" },
  { label: "累计访问数", key: "totalVisits" }, { label: "未关联会话数", key: "unassociatedSessionCount" },
  { label: "关联情况", key: "association" },
  { label: "首次发现（北京时间）", key: "firstSeenAt", format: formatBeijingDateTime },
  { label: "末次发现（北京时间）", key: "lastSeenAt", format: formatBeijingDateTime },
];

export function advertiserCsvRows(items: AdvertiserAccountItem[]) {
  return items.map(item => ({
    ...item,
    // Apostrophe is intentional: no formulas, leading-zero loss or numeric rounding in spreadsheets.
    advertiserId: `'${item.advertiserId}`,
    platformName: safeCsvText(item.platformName || `平台 #${item.platformId}`),
    managedAccountNames: safeCsvText(item.managedAccountNames.join("、")),
    usernames: safeCsvText(item.usernames.join("、")),
    association: advertiserAssociationLabel(item),
  }));
}

async function copyAdvertiserId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast.success("广告 ID 已复制");
  } catch { toast.error("复制失败，请手动选择广告 ID 复制"); }
}

export function AdvertiserAccountsTable({ items, loading = false, error, onSelect }: {
  items: AdvertiserAccountItem[];
  loading?: boolean;
  error?: string | null;
  onSelect: (item: AdvertiserAccountItem) => void;
}) {
  if (loading) return <p role="status" className="p-8 text-center text-sm text-muted-foreground">加载广告账户…</p>;
  if (error) return <p role="alert" className="p-8 text-center text-sm text-destructive">{error}</p>;
  if (!items.length) return <p className="p-8 text-center text-sm text-muted-foreground">暂无广告账户访问记录，请调整筛选条件。</p>;
  return <Table>
    <TableHeader><TableRow>
      {["广告 ID", "平台", "巨量账号", "桌面用户", "首次发现", "末次发现", "会话数", "关联情况", "操作"].map(label => <TableHead key={label}>{label}</TableHead>)}
    </TableRow></TableHeader>
    <TableBody>{items.map(item => <TableRow key={`${item.platformId}:${item.advertiserId}`}>
      <TableCell><div className="flex items-center gap-1"><span className="font-mono text-xs break-all">{item.advertiserId}</span><Button variant="ghost" size="icon-sm" title="复制广告 ID" aria-label={`复制广告 ID ${item.advertiserId}`} onClick={() => void copyAdvertiserId(item.advertiserId)}><Copy className="h-3.5 w-3.5" /></Button></div></TableCell>
      <TableCell>{item.platformName || `平台 #${item.platformId}`}</TableCell>
      <TableCell><div>{item.managedAccountNames.slice(0, 3).join("、") || "—"}</div><span className="text-xs text-muted-foreground">{item.managedAccountCount} 个账号</span></TableCell>
      <TableCell><div>{item.usernames.slice(0, 3).join("、") || "—"}</div><span className="text-xs text-muted-foreground">{item.userCount} 位用户</span></TableCell>
      <TableCell className="whitespace-nowrap text-xs">{formatBeijingDateTime(item.firstSeenAt)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs">{formatBeijingDateTime(item.lastSeenAt)}</TableCell>
      <TableCell>{item.sessionCount}</TableCell>
      <TableCell><Badge variant={item.unassociatedSessionCount ? "warning" : "outline"}>{advertiserAssociationLabel(item)}</Badge></TableCell>
      <TableCell><Button variant="outline" size="sm" onClick={() => onSelect(item)}>查看来源</Button></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

interface AdvertiserAccountsViewProps {
  users: DesktopUser[];
  platforms: PlatformItem[];
  onLoadDetail: (id: number) => Promise<BrowserSessionDetail>;
}

/** A changed admin ID remounts all data, options, detail and in-flight guards. */
export function AdvertiserAccountsView(props: AdvertiserAccountsViewProps) {
  const { user } = useAuth();
  return user ? <AdvertiserAccountsScope key={user.id} {...props} /> : null;
}

function AdvertiserAccountsScope({ users, platforms, onLoadDetail }: AdvertiserAccountsViewProps) {
  const [filters, setFilters] = useState<AdvertiserAccountFilters>({ ...EMPTY_ADVERTISER_FILTERS });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: AdvertiserPage<AdvertiserAccountItem>; error?: string } | null>(null);
  const [options, setOptions] = useState<AdvertiserAccountOptions>(EMPTY_OPTIONS);
  const [optionsSearch, setOptionsSearch] = useState("");
  const [optionsPage, setOptionsPage] = useState(1);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [optionsResultKey, setOptionsResultKey] = useState("");
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [chosenOptions, setChosenOptions] = useState<{ platform?: NamedOption; managedAccount?: NamedOption }>({});
  const optionsSeq = useRef(0);
  const optionsKey = JSON.stringify([filters, optionsSearch, optionsPage, reload, optionsRetry]);
  const optionsLoading = optionsResultKey !== optionsKey;
  const [selected, setSelected] = useState<AdvertiserAccountItem | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportSeq = useRef(0);
  const query = useMemo(() => ({ ...toAdvertiserAccountQuery(filters), page, pageSize }), [filters, page, pageSize]);
  const requestKey = JSON.stringify([query, reload]);
  const current = result?.key === requestKey ? result : null;
  const loading = !current;

  useEffect(() => {
    let active = true;
    api.listAdvertiserAccounts(query).then(data => {
      if (active) setResult({ key: requestKey, data });
    }).catch(error => {
      if (active) setResult({ key: requestKey, error: error instanceof Error ? error.message : "加载广告账户失败" });
    });
    return () => { active = false; };
  }, [query, requestKey]);

  useEffect(() => {
    const seq = ++optionsSeq.current;
    setOptionsError(null);
    // One bounded page per user action; no fetch-all loop.
    api.getAdvertiserAccountOptions({ ...toAdvertiserAccountQuery(filters), search: optionsSearch, page: optionsPage, pageSize: 100 }).then(data => {
      if (seq === optionsSeq.current) setOptions(previous => mergeAdvertiserOptionPage(previous, data));
    }).catch(error => {
      if (seq === optionsSeq.current) setOptionsError(error instanceof Error ? error.message : "加载筛选选项失败");
    }).finally(() => {
      if (seq === optionsSeq.current) setOptionsResultKey(optionsKey);
    });
    return () => { optionsSeq.current += 1; };
  }, [optionsKey]);

  const resetOptions = () => {
    optionsSeq.current += 1;
    setOptions(EMPTY_OPTIONS);
    setOptionsPage(1);
    setOptionsRetry(value => value + 1);
    setOptionsError(null);
  };

  useEffect(() => () => { exportSeq.current += 1; }, []);

  const changeFilters = (next: AdvertiserAccountFilters) => {
    setChosenOptions(previous => ({
      platform: next.platformId === "ALL" ? undefined : options.platforms.find(item => String(item.id) === next.platformId) || (String(previous.platform?.id) === next.platformId ? previous.platform : undefined),
      managedAccount: next.managedAccountId === "ALL" ? undefined : options.managedAccounts.find(item => String(item.id) === next.managedAccountId) || (String(previous.managedAccount?.id) === next.managedAccountId ? previous.managedAccount : undefined),
    }));
    resetOptions();
    exportSeq.current += 1;
    setExporting(false);
    setSelected(null);
    setFilters(next);
    setPage(1);
  };

  const exportCsv = async () => {
    const seq = ++exportSeq.current;
    setExporting(true);
    try {
      const items = await api.fetchAllAdvertiserAccounts(query);
      if (seq !== exportSeq.current) return;
      if (!items.length) { toast.warning("当前筛选条件下无数据可导出"); return; }
      exportToCsvFile(advertiserCsvHeaders, advertiserCsvRows(items), `vestus-advertiser-accounts-${beijingDateStamp()}.csv`);
      toast.success(`已导出 ${items.length} 条广告账户访问记录`);
    } catch (error) {
      if (seq === exportSeq.current) toast.error("导出 CSV 失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      if (seq === exportSeq.current) setExporting(false);
    }
  };

  // Only options previously returned inside this admin's scope can be retained.
  const keepChosen = (items: NamedOption[], chosen?: NamedOption) => chosen && !items.some(item => item.id === chosen.id) ? [chosen, ...items] : items;
  const scopePlatforms = keepChosen(options.platforms, chosenOptions.platform).map(item => ({ ...item, name: platforms.find(platform => platform.id === item.id)?.name || item.name }));
  const scopeManagedAccounts = keepChosen(options.managedAccounts, chosenOptions.managedAccount);
  return <>
    <PageToolbar><h2 className="text-sm font-medium">广告账户访问记录</h2><PageToolbarActions>
      <Button variant="outline" size="sm" onClick={() => { resetOptions(); setReload(value => value + 1); setSelected(null); }} disabled={loading}>刷新</Button>
      <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting || loading || Boolean(current?.error)}>{exporting ? "正在导出…" : "导出广告账户 CSV"}</Button>
    </PageToolbarActions></PageToolbar>
    <AdvertiserAccountFiltersBar filters={filters} users={users} platforms={scopePlatforms} managedAccounts={scopeManagedAccounts} onChange={changeFilters} />
    <AdvertiserOptionsSearch search={optionsSearch} options={options} loading={optionsLoading} error={optionsError} onSearch={value => { resetOptions(); setOptionsSearch(value); }} onLoadMore={() => { if (!optionsLoading && !optionsError) setOptionsPage(options.page + 1); }} onRetry={() => setOptionsRetry(value => value + 1)} />
    <p className="px-4 py-3 text-xs text-muted-foreground">{ADVERTISER_ACCESS_NOTICE}</p>
    <AdvertiserAccountsTable items={current?.data?.items || []} loading={loading} error={current?.error} onSelect={setSelected} />
    <TablePagination currentPage={page} totalPages={current?.data?.pages || 1} totalItems={current?.data?.total || 0} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} disabled={loading} />
    {selected && <AdvertiserAccountDetail key={`${selected.platformId}:${selected.advertiserId}:${JSON.stringify(filters)}`} account={selected} query={toAdvertiserAccountQuery(filters)} onClose={() => setSelected(null)} onLoadDetail={onLoadDetail} />}
  </>;
}
