interface ProxyIpConfig {
  proxy_assigned: boolean;
  proxy_ip?: string | null;
}

export function getProxyIpDisplay(
  config: ProxyIpConfig | null | undefined,
  configLoading: boolean,
  phase: string,
): string {
  if (configLoading || phase === "testing") return "正在探测…";
  if (!config?.proxy_assigned) return "—";
  return config.proxy_ip || "等待探测";
}

export function getDirectConnectionStatus(
  directIp: string | null,
  loading: boolean,
): string {
  if (loading) return "正在检测…";
  if (directIp === "获取失败") return "IP 获取失败";
  if (directIp) return "直连正常";
  return "等待检测";
}
