export interface ProxyItem {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 直连域名（已由服务端归一化）。空数组表示全部流量走该代理。 */
  bypassHosts?: string[];
  status: "active" | "disabled";
  /** 默认节点：未单独配置 VPN 的用户走这条。全局最多一条默认。 */
  isDefault?: boolean;
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
  isDefault?: boolean;
}

export interface UpdateProxyPayload {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  bypassHosts?: string[];
  status?: "active" | "disabled";
  isDefault?: boolean;
}
