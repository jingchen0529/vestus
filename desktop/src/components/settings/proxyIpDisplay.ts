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
