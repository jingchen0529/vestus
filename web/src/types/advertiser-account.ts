import type { BrowserSessionFilters, BrowserSessionQuery } from "./browser-activity";
import { EMPTY_BROWSER_SESSION_FILTERS, toBrowserSessionQuery } from "./browser-activity";

export interface AdvertiserAccountQuery extends BrowserSessionQuery {
  sessionId?: number;
  advertiserId?: string;
  managedAccountId?: number;
}

export interface AdvertiserAccountFilters extends BrowserSessionFilters {
  advertiserId: string;
  managedAccountId: string;
}

export const EMPTY_ADVERTISER_FILTERS: AdvertiserAccountFilters = {
  ...EMPTY_BROWSER_SESSION_FILTERS, advertiserId: "", managedAccountId: "ALL",
};

export function toAdvertiserAccountQuery(filters: AdvertiserAccountFilters): AdvertiserAccountQuery {
  return {
    ...toBrowserSessionQuery(filters),
    advertiserId: filters.advertiserId || undefined,
    managedAccountId: filters.managedAccountId === "ALL" ? undefined : Number(filters.managedAccountId),
  };
}

export interface AdvertiserAccountItem {
  advertiserId: string;
  platformId: number;
  platformName: string | null;
  managedAccountCount: number;
  userCount: number;
  sessionCount: number;
  pageCount: number;
  totalVisits: number;
  unassociatedSessionCount: number;
  managedAccountNames: string[];
  usernames: string[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface AdvertiserPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export type AdvertiserIdentitySource = "bootstrap" | "historical" | "unassociated";

export interface AdvertiserAssociation {
  managedAccountId: number | null;
  managedAccountName: string | null;
  remoteAccountId: string | null;
  remoteDisplayName: string | null;
  identitySource: AdvertiserIdentitySource;
  credentialVersion: number | null;
  userCount: number;
  sessionCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface AdvertiserSource {
  pageId: number;
  sessionId: number;
  userId: number;
  username: string;
  managedAccountId: number | null;
  managedAccountName: string | null;
  remoteAccountId: string | null;
  identitySource: AdvertiserIdentitySource;
  url: string;
  urlParams: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  visits: number;
  clicks: number;
  inputs: number;
  submits: number;
}

export interface AdvertiserAccountOptionsQuery extends AdvertiserAccountQuery {
  search?: string;
}

export interface AdvertiserAccountOptions {
  managedAccounts: { id: number; name: string }[];
  platforms: { id: number; name: string }[];
  page: number;
  pageSize: number;
  managedAccountsHasMore: boolean;
  platformsHasMore: boolean;
}
