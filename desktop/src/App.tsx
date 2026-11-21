import React, { useRef, useState, useEffect } from "react";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { ThemeProvider } from "@/hooks/useTheme";
import { Sidebar, NavTab } from "@/components/layout/Sidebar";
import { LoginCard } from "@/components/auth/LoginCard";
import { ChangePasswordCard } from "@/components/auth/ChangePasswordCard";
import { PlatformLauncher } from "@/components/browser/PlatformLauncher";
import { FaqView } from "@/components/faq/FaqView";
import { SystemSettings } from "@/components/settings/SystemSettings";
import { authService, UserAccount } from "@/services/authService";
import { createDesktopConfigSync } from "@/services/desktopConfigSync";
import { createNetworkDiagnosticsController } from "@/services/networkDiagnosticsController";
import {
  DesktopConfigView,
  isTauri,
  tauriBridge,
  StatusView,
  NetworkDiagnosticsSnapshot,
} from "@/services/tauriBridge";

function MainLayout() {
  const { success, error, info } = useToast();
  const desktopRuntime = isTauri();
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(
    authService.getCurrentUser()
  );
  const [authReady, setAuthReady] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [productName, setProductName] = useState("Vestus");
  const [logoUrl, setLogoUrl] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<NavTab>("platforms");
  const [desktopConfig, setDesktopConfig] = useState<DesktopConfigView | null>(null);
  const [desktopConfigLoading, setDesktopConfigLoading] = useState(false);
  const [desktopConfigError, setDesktopConfigError] = useState<string | null>(null);
  const [networkDiagnostics, setNetworkDiagnostics] = useState<NetworkDiagnosticsSnapshot | null>(null);
  const [networkDiagnosticsLoading, setNetworkDiagnosticsLoading] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("vestus-desktop-proxy-enabled");
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });
  // 浏览器沙箱是本机偏好：默认开启；沙箱拉不起来的机器由用户在「系统配置」里关闭。
  const [sandboxEnabled, setSandboxEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("vestus-desktop-sandbox-enabled");
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  const [status, setStatus] = useState<StatusView>({
    phase: "unconfigured",
    message: "正在初始化代理环境…",
    browser_open: false,
  });

  // Each login (including the same account logging in again) owns its own async results.
  const loginGenerationRef = useRef(0);
  const configSyncRef = useRef<ReturnType<typeof createDesktopConfigSync> | null>(null);
  const networkDiagnosticsRefreshRef = useRef<(() => void) | null>(null);
  const networkDiagnosticsInvalidateRef = useRef<(() => void) | null>(null);
  const focusSyncRef = useRef<(() => void) | null>(null);
  const lastFocusSyncAtRef = useRef(0);

  const invalidateConfigSync = () => {
    loginGenerationRef.current += 1;
    configSyncRef.current?.invalidate();
    networkDiagnosticsInvalidateRef.current?.();
    lastFocusSyncAtRef.current = 0;
    setDesktopConfigLoading(false);
    return loginGenerationRef.current;
  };

  const replaceCurrentUser = (user: UserAccount | null) => {
    invalidateConfigSync();
    setDesktopConfig(null);
    setDesktopConfigError(null);
    setCurrentUser(user);
  };

  const expireSession = async (message: string) => {
    const generation = invalidateConfigSync();
    setAuthNotice(message);
    setDesktopConfig(null);
    setDesktopConfigError(null);
    try {
      await tauriBridge.stopNetworkDiagnostics().catch(() => undefined);
      await authService.logout();
    } catch (reason) {
      if (generation === loginGenerationRef.current) {
        setAuthNotice(
          `${message}；${reason instanceof Error ? reason.message : "本地凭据清理失败"}`
        );
      }
    } finally {
      if (generation === loginGenerationRef.current) setCurrentUser(null);
    }
  };

  if (!configSyncRef.current) {
    configSyncRef.current = createDesktopConfigSync({
      syncConfig: () => tauriBridge.syncDesktopConfig(),
      getStatus: () => tauriBridge.getStatus(),
      onConfig: setDesktopConfig,
      onStatus: setStatus,
      onLoading: (loading) => {
        setDesktopConfigLoading(loading);
        if (loading) setDesktopConfigError(null);
      },
      onSuccess: (config, announce) => {
        if (!config.proxy_assigned) {
          setDesktopConfigError("系统当前没有启用的全局代理；如需继续访问，请切换为直连模式");
        } else if (config.platforms.length === 0) {
          setDesktopConfigError("代理已就绪，但系统当前没有已启用的平台入口");
        } else if (announce) {
          success("桌面配置已同步", `已加载 ${config.platforms.length} 个平台入口`);
        }
        networkDiagnosticsInvalidateRef.current?.();
        networkDiagnosticsRefreshRef.current?.();
      },
      onError: (reason, announce) => {
        const err = reason as { code?: string; message?: string } | null;
        const message = err?.message || (typeof reason === "string" ? reason : "无法获取全局桌面配置");
        // Transient network/server failures leave the last usable config intact.
        setDesktopConfigError(message);
        if (err?.code === "unauthenticated") void expireSession(message);
        if (announce) error("同步配置失败", message);
      },
    });
  }

  useEffect(() => () => {
    loginGenerationRef.current += 1;
    configSyncRef.current?.invalidate();
  }, []);

  // A session is only considered valid after the server confirms the token.
  useEffect(() => {
    if (!desktopRuntime) {
      setAuthReady(true);
      return;
    }
    let mounted = true;
    authService
      .restoreSession()
      .then((user) => {
        if (mounted) replaceCurrentUser(user);
      })
      .finally(() => {
        if (mounted) setAuthReady(true);
      });
    return () => {
      mounted = false;
    };
  }, [desktopRuntime]);

  useEffect(() => {
    if (!desktopRuntime) return;
    let mounted = true;
    void authService.getProductInfo().then((info) => {
      if (mounted) {
        setProductName(info.productName || "Vestus");
        setLogoUrl(info.logoUrl);
      }
    });
    return () => {
      mounted = false;
    };
  }, [desktopRuntime]);

  // 监听 Tauri 状态变更
  useEffect(() => {
    if (
      !desktopRuntime ||
      !authReady ||
      !currentUser ||
      !authService.isAuthenticated()
    ) {
      return;
    }
    let active = true;
    const generation = loginGenerationRef.current;
    const isActive = () => active && generation === loginGenerationRef.current;
    let unlistenFn: (() => void) | undefined;
    let unlistenExpiredFn: (() => void) | undefined;
    let unlistenRecoveredFn: (() => void) | undefined;
    let unlistenGuardFailedFn: (() => void) | undefined;
    let unlistenPageGuardFailedFn: (() => void) | undefined;

    void tauriBridge
      .getStatus()
      .then((initialStatus) => {
        if (isActive()) setStatus(initialStatus);
      })
      .catch(() => {
        // Config synchronization below reports actionable initialization errors.
      });

    tauriBridge
      .onStatusChange((newStatus) => {
        if (!isActive()) return;
        setStatus(newStatus);
        if (newStatus.error_code === "unauthenticated") {
          void expireSession("登录已失效，代理和浏览器已关闭，请重新登录");
        } else if (newStatus.error_code === "desktop_config_changed") {
          // A lease change discovered by this sync needs one fresh request after it settles.
          void syncDesktopConfig(false, true).then((synced) => {
            if (synced && isActive()) {
              info("配置已自动同步", "管理员更新了全局配置或托管账号凭据，已自动生效");
            }
          });
        }
      })
      .then((unlisten) => {
        if (isActive()) unlistenFn = unlisten;
        else unlisten();
      })
      .catch(() => {
        // A failed event subscription must not create an unhandled rejection.
      });

    // 服务端回执后再刷新，不能让旧 watcher 的通知把新凭据显示为失效。
    tauriBridge
      .onManagedSessionExpired((payload) => {
        if (!isActive()) return;
        if (!payload.browserClosed) {
          error("托管浏览器清理未完成", "请关闭对应浏览器后重试；系统没有确认该会话已完全关闭");
        } else if (!payload.reported) {
          error("托管浏览器已关闭", "检测到平台登出，但失效状态上报未完成，请检查网络并联系管理员");
        } else if (payload.sessionStatus === "expired") {
          error("托管登录已失效", "平台登出已上报，浏览器已关闭；请联系管理员更新凭据");
        } else {
          info("旧托管会话已关闭", "管理员已更新凭据，本次旧会话上报未影响新凭据");
        }
        if (payload.reported && payload.applied) {
          void syncDesktopConfig(false);
        }
      })
      .then((unlisten) => {
        if (isActive()) unlistenExpiredFn = unlisten;
        else unlisten();
      })
      .catch(() => {
        // A failed event subscription must not create an unhandled rejection.
      });

    // 服务端自动登录完成：刷新配置后按当前本机偏好自动重新打开托管浏览器。
    tauriBridge
      .onManagedSessionRecovered((payload) => {
        if (!isActive()) return;
        if (!payload.recovered) {
          error("自动恢复登录未完成", payload.detail || "请联系管理员检查账号凭据");
          void syncDesktopConfig(false);
          return;
        }
        void (async () => {
          try {
            if (!(await syncDesktopConfig(false)) || !isActive()) return;
            info("托管登录已自动恢复", "正在重新打开该平台的托管浏览器");
            let proxyStored = true;
            let sandboxStored = true;
            try {
              proxyStored = localStorage.getItem("vestus-desktop-proxy-enabled") !== "false";
              sandboxStored = localStorage.getItem("vestus-desktop-sandbox-enabled") !== "false";
            } catch {
              // 读不到本机偏好时使用默认值（代理 + 沙箱）。
            }
            await tauriBridge.openBrowser(
              payload.platformId,
              payload.managedAccountId,
              !proxyStored,
              !sandboxStored,
            );
            if (isActive()) success("托管浏览器已恢复", "已用新的登录状态重新打开平台");
          } catch (reopenError) {
            if (isActive()) {
              error("自动恢复后重新打开失败", reopenError instanceof Error ? reopenError.message : "请手动重新打开平台");
            }
          }
        })();
      })
      .then((unlisten) => {
        if (isActive()) unlistenRecoveredFn = unlisten;
        else unlisten();
      })
      .catch(() => {
        // A failed event subscription must not create an unhandled rejection.
      });

    // 安全监控中断不代表凭据失效；这里只提示，浏览器退出状态由 status-changed 更新。
    tauriBridge
      .onManagedSessionGuardFailed((payload) => {
        if (!isActive()) return;
        const cause =
          payload.reason === "monitor_disconnected" ? "安全监控连接断开" : "安全监控中断";
        if (payload.browserClosed) {
          error("托管浏览器已关闭", cause + "，请重新打开平台；托管账号凭据未被标记为失效");
        } else {
          error("托管浏览器关闭未确认", cause + "，请手动关闭对应浏览器后重试");
        }
      })
      .then((unlisten) => {
        if (isActive()) unlistenGuardFailedFn = unlisten;
        else unlisten();
      })
      .catch(() => {
        // A failed event subscription must not create an unhandled rejection.
      });

    // 后续标签页的局部防护故障不关闭其他页面，也不刷新凭据或自动重开。
    tauriBridge
      .onManagedPageGuardFailed((payload) => {
        if (!isActive() || !payload.pageClosed) return;
        error(
          "托管标签页已关闭",
          "该标签页安全防护初始化失败，已仅关闭此标签页；其他页面可继续使用，托管账号凭据未被标记为失效",
        );
      })
      .then((unlisten) => {
        if (isActive()) unlistenPageGuardFailedFn = unlisten;
        else unlisten();
      })
      .catch(() => {
        // A failed event subscription must not create an unhandled rejection.
      });

    return () => {
      active = false;
      if (unlistenFn) unlistenFn();
      if (unlistenExpiredFn) unlistenExpiredFn();
      if (unlistenRecoveredFn) unlistenRecoveredFn();
      if (unlistenGuardFailedFn) unlistenGuardFailedFn();
      if (unlistenPageGuardFailedFn) unlistenPageGuardFailedFn();
    };
  }, [desktopRuntime, authReady, currentUser]);

  useEffect(() => {
    if (!desktopRuntime || !authReady || !currentUser || !authService.isAuthenticated()) return;
    let active = true;
    let unlistenNetworkDiagnostics: (() => void) | undefined;
    const diagnostics = createNetworkDiagnosticsController({
      start: () => tauriBridge.startNetworkDiagnostics(),
      getSnapshot: () => tauriBridge.getNetworkDiagnostics(),
      stop: () => tauriBridge.stopNetworkDiagnostics(),
      onSnapshot: (snapshot) => {
        if (active) setNetworkDiagnostics(snapshot);
      },
      onLoading: (loading) => {
        if (active) setNetworkDiagnosticsLoading(loading);
      },
    });
    networkDiagnosticsRefreshRef.current = () => {
      if (active) void diagnostics.refresh();
    };
    networkDiagnosticsInvalidateRef.current = diagnostics.invalidate;
    setNetworkDiagnosticsLoading(true);
    tauriBridge.onNetworkDiagnosticsChange((snapshot) => {
      if (active) {
        setNetworkDiagnostics(snapshot);
        setNetworkDiagnosticsLoading(false);
      }
    }).then((unlisten) => {
      if (active) unlistenNetworkDiagnostics = unlisten;
      else unlisten();
    }).catch(() => {
      if (active) setNetworkDiagnosticsLoading(false);
    });
    void syncDesktopConfig(false).then((synced) => {
      if (active && !synced) setNetworkDiagnosticsLoading(false);
    });
    return () => {
      active = false;
      unlistenNetworkDiagnostics?.();
      networkDiagnosticsRefreshRef.current = null;
      networkDiagnosticsInvalidateRef.current = null;
      diagnostics.dispose();
      setNetworkDiagnostics(null);
    };
  }, [desktopRuntime, authReady, currentUser]);

  // 管理员处理完凭据（如重新保存 Cookie）后，用户切回本窗口即自动同步一次
  // 登录状态，免去手动点「刷新」；60 秒节流，避免频繁触发服务端会话探测。
  focusSyncRef.current = () => {
    if (!desktopRuntime || !authReady || !currentUser || !authService.isAuthenticated()) return;
    const now = Date.now();
    if (now - lastFocusSyncAtRef.current < 60_000) return;
    lastFocusSyncAtRef.current = now;
    void syncDesktopConfig(false);
  };
  useEffect(() => {
    if (!desktopRuntime) return;
    const onFocus = () => focusSyncRef.current?.();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [desktopRuntime]);

  const syncDesktopConfig = (announce = false, afterPending = false): Promise<boolean> => {
    if (
      !desktopRuntime ||
      !authReady ||
      !currentUser ||
      authService.getCurrentUser() !== currentUser ||
      !authService.isAuthenticated()
    ) {
      return Promise.resolve(false);
    }
    return afterPending
      ? configSyncRef.current!.syncAfterPending()
      : configSyncRef.current!.sync(announce);
  };

  // Desktop users receive proxy credentials and allowed platform entries through
  // Rust after login. The secret never crosses into this React process.
  useEffect(() => {
    if (
      !desktopRuntime ||
      !authReady ||
      !currentUser ||
      !authService.isAuthenticated()
    ) {
      return;
    }
    void syncDesktopConfig(false);
  }, [desktopRuntime, authReady, currentUser]);

  const handleLoginSuccess = (user: UserAccount) => {
    setAuthNotice(null);
    replaceCurrentUser(user);
  };

  const handleLogout = async () => {
    const generation = invalidateConfigSync();
    let failure: string | null = null;
    try {
      await tauriBridge.stopNetworkDiagnostics().catch(() => undefined);
      await authService.logout();
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : "本地登录凭据清理失败";
    }
    if (generation !== loginGenerationRef.current) return;
    setCurrentUser(null);
    setDesktopConfig(null);
    setDesktopConfigError(null);
    setAuthNotice(failure);
    if (failure) error("退出未完全成功", failure);
    else info("已安全退出", "请重新登录以继续使用系统");
  };

  const handleProxyEnabledChange = (enabled: boolean) => {
    setProxyEnabled(enabled);
    try {
      localStorage.setItem("vestus-desktop-proxy-enabled", String(enabled));
    } catch {}
    if (enabled) {
      info("已切换为代理模式", "平台访问将通过系统当前启用的全局代理转发");
    } else {
      info("已切换为直连模式", "平台访问将直接使用本机网络访问");
    }
  };

  const handleSandboxEnabledChange = (enabled: boolean) => {
    setSandboxEnabled(enabled);
    try {
      localStorage.setItem("vestus-desktop-sandbox-enabled", String(enabled));
    } catch {}
    if (enabled) {
      info("已开启浏览器沙箱", "浏览器将以完整的安全沙箱运行（推荐）");
    } else {
      info(
        "已关闭浏览器沙箱",
        "仅在浏览器无法打开时使用；代理与网络隔离不受影响"
      );
    }
  };

  const handleOpenBrowser = async (platformId: number, managedAccountId?: number) => {
    try {
      const directMode = !proxyEnabled;
      const disableSandbox = !sandboxEnabled;
      const handle = await tauriBridge.openBrowser(
        platformId,
        managedAccountId ?? null,
        directMode,
        disableSandbox,
      );
      if (handle.reused) {
        success("已切回该平台页面", "浏览器里已有的页面原样保留，不会重复开新标签或窗口");
      } else if (handle.managed) {
        success("托管浏览器已启动", "后台已注入登录状态，客户无需输入方舟账号密码");
      } else if (handle.direct_mode) {
        success("直连浏览器已启动", "已在本机的直连浏览器环境中打开平台，登录状态会保留");
      } else {
        success("代理浏览器已启动", "已在本机的代理浏览器环境中打开平台，登录状态会保留");
      }
    } catch (err: any) {
      error("打开浏览器失败", err.message || "请稍后重试或联系管理员");
    }
  };

  const handleResetBrowserProfiles = async () => {
    try {
      const { removed } = await tauriBridge.resetBrowserProfiles();
      success(
        "浏览器环境已重置",
        removed > 0
          ? `已清除本账号在这台电脑上的 ${removed} 个平台环境，再打开时需要重新登录`
          : "本账号在这台电脑上还没有保存过浏览器环境"
      );
    } catch (err: any) {
      error("重置浏览器环境失败", err?.message || "请关闭所有浏览器后重试");
    }
  };

  if (!desktopRuntime) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-sm rounded-[14px] border border-border/70 bg-card p-6 text-center shadow-soft">
          <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Vestus 桌面客户端</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            桌面端用户登录只能在 Tauri 客户端中使用，浏览器端仅提供管理员后台。
          </p>
          <p className="mt-3 text-[11px] text-muted-foreground/70">
            请访问管理员提供的 Web 后台地址
          </p>
        </div>
      </div>
    );
  }

  if (!authReady) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background text-muted-foreground">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          正在验证登录状态…
        </div>
      </div>
    );
  }

  // 未登录时展示登录页
  if (!currentUser || !authService.isAuthenticated()) {
    return (
      <LoginCard
        productName={productName}
        logoUrl={logoUrl}
        notice={authNotice}
        onLoginSuccess={handleLoginSuccess}
      />
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground transition-colors relative">
      {/* Draggable header region across main window */}
      <div data-tauri-drag-region className="absolute left-52 right-0 top-0 z-30 h-8 cursor-default select-none" />

      <Sidebar
        productName={productName}
        logoUrl={logoUrl}
        user={currentUser}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onLogout={handleLogout}
      />

      <main className="h-screen flex-1 overflow-y-auto px-5 pb-8 pt-10 sm:px-7">
        {activeTab === "platforms" ? (
          <PlatformLauncher
            status={status}
            desktopConfig={desktopConfig}
            configLoading={desktopConfigLoading}
            configError={desktopConfigError}
            proxyEnabled={proxyEnabled}
            onRetryConfig={() => syncDesktopConfig(true)}
            onOpenBrowser={handleOpenBrowser}
            networkDiagnostics={networkDiagnostics}
            networkDiagnosticsLoading={networkDiagnosticsLoading}
          />
        ) : activeTab === "faq" ? (
          <FaqView />
        ) : (
          <SystemSettings
            productName={productName}
            logoUrl={logoUrl}
            user={currentUser}
            status={status}
            desktopConfig={desktopConfig}
            configLoading={desktopConfigLoading}
            proxyEnabled={proxyEnabled}
            onProxyEnabledChange={handleProxyEnabledChange}
            sandboxEnabled={sandboxEnabled}
            onSandboxEnabledChange={handleSandboxEnabledChange}
            onResetBrowserProfiles={handleResetBrowserProfiles}
            onSyncConfig={() => syncDesktopConfig(true)}
            networkDiagnostics={networkDiagnostics}
            networkDiagnosticsLoading={networkDiagnosticsLoading}
          />
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="vestus-desktop-theme">
      <ToastProvider>
        <MainLayout />
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
