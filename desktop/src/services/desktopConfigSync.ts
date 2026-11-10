import type { DesktopConfigView, StatusView } from "./tauriBridge";

interface DesktopConfigSyncOptions {
  syncConfig: () => Promise<DesktopConfigView>;
  getStatus?: () => Promise<StatusView>;
  onConfig: (config: DesktopConfigView) => void;
  onStatus?: (status: StatusView) => void;
  onSuccess?: (config: DesktopConfigView, announce: boolean) => void;
  onError?: (reason: unknown, announce: boolean) => void;
  onLoading?: (loading: boolean) => void;
}

export function createDesktopConfigSync(options: DesktopConfigSyncOptions) {
  let generation = 0;
  let pending: Promise<boolean> | null = null;
  let followUp: Promise<boolean> | null = null;
  let shouldAnnounce = false;

  const coordinator = {
    invalidate(): void {
      generation += 1;
      pending = null;
      followUp = null;
    },
    // Only explicit config-change events need a fresh request after the current one.
    // Keep this slot through the follow-up itself so repeated events cannot loop.
    syncAfterPending(): Promise<boolean> {
      if (followUp) return followUp;
      const queuedAt = generation;
      const request = (pending ?? Promise.resolve(false))
        .then(() => queuedAt === generation ? coordinator.sync() : false)
        .finally(() => {
          if (followUp === request) followUp = null;
        });
      followUp = request;
      return request;
    },
    sync(announce = false): Promise<boolean> {
      if (pending) {
        shouldAnnounce ||= announce;
        return pending;
      }
      shouldAnnounce = announce;
      const startedAt = generation;
      const request = (async () => {
        try {
          options.onLoading?.(true);
          const config = await options.syncConfig();
          if (startedAt !== generation) return false;
          options.onConfig(config);
          try {
            const status = await options.getStatus?.();
            if (startedAt !== generation) return false;
            if (status) options.onStatus?.(status);
          } catch {
            // Status events remain authoritative; a failed status read is non-fatal.
          }
          if (startedAt !== generation) return false;
          options.onSuccess?.(config, shouldAnnounce);
          return true;
        } catch (reason) {
          if (startedAt === generation) options.onError?.(reason, shouldAnnounce);
          return false;
        } finally {
          if (startedAt === generation) options.onLoading?.(false);
        }
      })().finally(() => {
        if (pending === request) pending = null;
      });
      pending = request;
      return request;
    },
  };
  return coordinator;
}
