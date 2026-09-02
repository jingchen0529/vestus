// Tauri IPC bridge. Browser/Web code must fail closed instead of simulating
// desktop proxy or external-browser capabilities.

export interface DesktopPlatform {
  id: number;
  name: string;
  icon_url?: string | null;
}

export interface DesktopConfigView {
  proxy_assigned: boolean;
  /** 通过当前全局代理探测到的真实公网出口 IP。 */
  proxy_ip?: string | null;
  platforms: DesktopPlatform[];
  /** 管理员下发的直连域名（已归一化）。这些域名不走代理，用真实出口 IP 访问。 */
  direct_hosts: string[];
}

export type Phase =
  | "unconfigured"
  | "testing"
  | "ready"
  | "browser_running"
  | "proxy_error";

export interface StatusView {
  phase: Phase;
  message: string;
  browser_open: boolean;
  error_code?: string;
}

export interface BrowserHandleView {
  /** 仅用于把状态机里的会话和 Chromium 进程对上，前端不需要它做别的事。 */
  browser_id: number;
}

// 检查是否运行在桌面原生 Tauri 环境
export const isTauri = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
};

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("该功能仅可在 Vestus 桌面客户端中使用");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(command, args);
}

export const tauriBridge = {
  async syncDesktopConfig(): Promise<DesktopConfigView> {
    return await invokeDesktop<DesktopConfigView>("sync_desktop_config");
  },

  async openBrowser(
    platformId: number,
    directMode: boolean = false,
    disableSandbox: boolean = false,
  ): Promise<BrowserHandleView> {
    return await invokeDesktop<BrowserHandleView>("open_browser", {
      platformId,
      directMode,
      disableSandbox,
    });
  },

  async getDirectIp(): Promise<string> {
    return await invokeDesktop<string>("get_direct_ip");
  },

  async getStatus(): Promise<StatusView> {
    return await invokeDesktop<StatusView>("get_status");
  },

  /**
   * 本机安装的版本号，来自打包时写进 tauri.conf.json 的那个值。
   *
   * 只有在 Tauri 窗口里才有；浏览器里跑的开发会话没有版本可言，返回空串让
   * 调用方显示「未知」，而不是替它编一个会过期的版本号。
   */
  async getAppVersion(): Promise<string> {
    if (!isTauri()) {
      return "";
    }
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    } catch {
      return "";
    }
  },

  async onStatusChange(callback: (status: StatusView) => void): Promise<() => void> {
    if (!isTauri()) {
      throw new Error("该功能仅可在 Vestus 桌面客户端中使用");
    }
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<StatusView>("status-changed", (event) => {
      callback(event.payload);
    });
  },

  async openExternalUrl(url: string): Promise<void> {
    if (!url) return;
    if (isTauri()) {
      try {
        await invokeDesktop<void>("open_external_url", { url });
        return;
      } catch (err) {
        console.warn("invokeDesktop open_external_url failed, falling back to window.open", err);
      }
    }
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // ignore
    }
  },
};
