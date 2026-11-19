import type { NetworkDiagnosticsSnapshot } from "./tauriBridge";

interface NetworkDiagnosticsControllerOptions {
  start: () => Promise<void>;
  getSnapshot: () => Promise<NetworkDiagnosticsSnapshot>;
  stop: () => Promise<void>;
  onSnapshot: (snapshot: NetworkDiagnosticsSnapshot) => void;
  onLoading?: (loading: boolean) => void;
}

export function createNetworkDiagnosticsController(
  options: NetworkDiagnosticsControllerOptions,
) {
  let active = true;
  let startPromise: Promise<void> | null = null;
  let stopRequested = false;
  let revision = 0;
  let runningRevision = 0;
  let refreshQueued = false;

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    void options.stop().catch(() => undefined);
  };

  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (startPromise) {
      if (runningRevision !== revision) refreshQueued = true;
      return startPromise;
    }
    const requestRevision = revision;
    const request = (async () => {
      options.onLoading?.(true);
      try {
        await options.start();
        if (!active || requestRevision !== revision) {
          if (!active) stop();
          return;
        }
        const snapshot = await options.getSnapshot();
        if (active && requestRevision === revision) options.onSnapshot(snapshot);
      } catch {
        // A failed start or snapshot read is reflected by the loading state.
      } finally {
        if (active) options.onLoading?.(false);
      }
    })().finally(() => {
      if (startPromise === request) {
        startPromise = null;
        if (active && refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    });
    runningRevision = requestRevision;
    startPromise = request;
    return request;
  };

  const invalidate = () => {
    revision += 1;
    refreshQueued = false;
  };

  const dispose = () => {
    if (!active) return;
    active = false;
    stop();
  };

  return { refresh, invalidate, dispose };
}
