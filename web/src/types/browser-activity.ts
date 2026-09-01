/** 桌面端上报的浏览器活动。计数字段都是一次会话内的累计值。 */
export interface BrowserSessionItem {
  id: number;
  userId: number;
  username: string;
  sessionKey: string;
  browserId: number;
  platformId: number;
  platformName?: string | null;
  /** 直连模式下打开的会话（未经上游代理）。 */
  directMode: boolean;
  /** 上报该会话的桌面客户端版本（如 v0.1.8）。 */
  clientVersion?: string | null;
  /** 这次会话记录到的不同地址数。 */
  pageCount: number;
  visits: number;
  clicks: number;
  inputs: number;
  submits: number;
  scrolls: number;
  /** 前台停留时长；标签页切到后台时不计。 */
  dwellMs: number;
  /** 客户端聚合表溢出而没记下的地址数，大于 0 表示这次会话的列表不完整。 */
  droppedPages: number;
  ipAddress?: string | null;
  startedAt?: string;
  lastReportAt?: string;
}

/** 一次会话里访问过的一个地址。只有 path，没有 query。 */
export interface BrowserPageVisitItem {
  id: number;
  url: string;
  visits: number;
  clicks: number;
  inputs: number;
  submits: number;
  scrolls: number;
  dwellMs: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** 与基础地址分离保存的查询参数，不拼回 URL。 */
  urlParams?: string | null;
  /** 最近一次采集到的客户输入字段快照。 */
  inputSnapshot?: Record<string, string[]> | null;
  inputSnapshotAt?: string | null;
  /** 最近一次表单提交字段快照。 */
  submitSnapshot?: Record<string, string[]> | null;
  submitSnapshotAt?: string | null;
}

export interface BrowserSessionDetail extends BrowserSessionItem {
  pages: BrowserPageVisitItem[];
}

export interface BrowserSessionResponse {
  items: BrowserSessionItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** 列表端点的查询参数。省略某项就是不按它筛。 */
export interface BrowserSessionQuery {
  page?: number;
  pageSize?: number;
  userId?: number;
  platformId?: number;
  directMode?: boolean;
  /** 只按 `YYYY-MM-DD` 传；后端把结束日期当成当天 23:59:59。 */
  startAt?: string;
  endAt?: string;
}

/** 列表页的筛选状态。下拉框用 "ALL" 表示不筛，日期用空串表示不限。 */
export interface BrowserSessionFilters {
  userId: string;
  platformId: string;
  connection: "ALL" | "DIRECT" | "PROXY";
  startAt: string;
  endAt: string;
}

export const EMPTY_BROWSER_SESSION_FILTERS: BrowserSessionFilters = {
  userId: "ALL",
  platformId: "ALL",
  connection: "ALL",
  startAt: "",
  endAt: "",
};

/** 把界面上的筛选状态翻成查询参数；"ALL" 和空串都落成 undefined。 */
export function toBrowserSessionQuery(
  filters: BrowserSessionFilters,
): Omit<BrowserSessionQuery, "page" | "pageSize"> {
  return {
    userId: filters.userId === "ALL" ? undefined : Number(filters.userId),
    platformId: filters.platformId === "ALL" ? undefined : Number(filters.platformId),
    directMode: filters.connection === "ALL" ? undefined : filters.connection === "DIRECT",
    startAt: filters.startAt || undefined,
    endAt: filters.endAt || undefined,
  };
}
