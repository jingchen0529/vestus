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

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    void options.stop().catch(() => undefined);
  };

  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (startPromise) return startPromise;
    const request = (async () => {
      options.onLoading?.(true);
      try {
        await options.start();
        if (!active) {
          stop();
          return;
        }
        const snapshot = await options.getSnapshot();
        if (active) options.onSnapshot(snapshot);
      } catch {
        // A failed start or snapshot read is reflected by the loading state.
      } finally {
        if (active) options.onLoading?.(false);
      }
    })().finally(() => {
      if (startPromise === request) startPromise = null;
    });
    startPromise = request;
    return request;
  };

  const dispose = () => {
    if (!active) return;
    active = false;
    stop();
  };

  return { refresh, dispose };
}
