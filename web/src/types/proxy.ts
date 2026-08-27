export interface ProxyItem {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 直连域名（已由服务端归一化）。空数组表示全部流量走该代理。 */
  bypassHosts?: string[];
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateProxyPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  bypassHosts: string[];
  status: "active" | "disabled";
}

export interface UpdateProxyPayload {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  bypassHosts?: string[];
  status?: "active" | "disabled";
}
