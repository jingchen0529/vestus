// Tauri IPC bridge. Browser/Web code must fail closed instead of simulating
// desktop proxy or external-browser capabilities.

export interface DesktopPlatform {
  id: number;
  name: string;
}

export interface DesktopConfigView {
  proxy_assigned: boolean;
  platforms: DesktopPlatform[];
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

  async openBrowser(platformId: number): Promise<void> {
    await invokeDesktop<void>("open_browser", {
      platformId,
    });
  },

  async getStatus(): Promise<StatusView> {
    return await invokeDesktop<StatusView>("get_status");
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
};
