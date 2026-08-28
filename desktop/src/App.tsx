import React, { useState, useEffect } from "react";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { ThemeProvider } from "@/hooks/useTheme";
import { Sidebar, NavTab } from "@/components/layout/Sidebar";
import { LoginCard } from "@/components/auth/LoginCard";
import { ChangePasswordCard } from "@/components/auth/ChangePasswordCard";
import { PlatformLauncher } from "@/components/browser/PlatformLauncher";
import { SystemSettings } from "@/components/settings/SystemSettings";
import { authService, UserAccount } from "@/services/authService";
import {
  DesktopConfigView,
  isTauri,
  tauriBridge,
  StatusView,
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
  const [proxyEnabled, setProxyEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("vestus-desktop-proxy-enabled");
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
        if (mounted) setCurrentUser(user);
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
    let unlistenFn: (() => void) | undefined;

    void tauriBridge
      .getStatus()
      .then((initialStatus) => {
        if (active) setStatus(initialStatus);
      })
      .catch(() => {
        // Config synchronization below reports actionable initialization errors.
      });

    tauriBridge
      .onStatusChange((newStatus) => {
        if (!active) return;
        setStatus(newStatus);
        if (newStatus.error_code === "unauthenticated") {
          const notice = "登录已失效，代理和浏览器已关闭，请重新登录";
          setAuthNotice(notice);
          void authService
            .logout()
            .catch((reason) => {
              if (active) {
                setAuthNotice(
                  `${notice}；${reason instanceof Error ? reason.message : "本地凭据清理失败"}`
                );
              }
            })
            .finally(() => {
              if (!active) return;
              setCurrentUser(null);
              setDesktopConfig(null);
              setDesktopConfigError(null);
            });
        } else if (newStatus.error_code === "desktop_config_changed") {
          setDesktopConfig(null);
          setDesktopConfigError("管理员已更新桌面配置，请重新同步后继续使用");
        }
      })
      .then((unlisten) => {
        if (active) unlistenFn = unlisten;
        else unlisten();
      })
      .catch(() => {
        // A failed event subscription must not create an unhandled rejection.
      });

    return () => {
      active = false;
      if (unlistenFn) unlistenFn();
    };
  }, [desktopRuntime, authReady, currentUser?.id]);

  const syncDesktopConfig = async (announce = false) => {
    if (
      !desktopRuntime ||
      !currentUser ||
      !authService.isAuthenticated()
    )
      return;
    setDesktopConfigLoading(true);
    setDesktopConfigError(null);
    try {
      const config = await tauriBridge.syncDesktopConfig();
      setDesktopConfig(config);
      try {
        setStatus(await tauriBridge.getStatus());
      } catch {
        // The status event normally updates this view; a failed refresh is non-fatal.
      }
      if (!config.proxy_assigned) {
        setDesktopConfigError("管理员尚未为该账号分配专属代理");
      } else if (config.platforms.length === 0) {
        setDesktopConfigError("代理已就绪，但管理员尚未分配平台入口");
      } else if (announce) {
        success(
          "桌面配置已同步",
          `已加载 ${config.platforms.length} 个平台入口`
        );
      }
    } catch (err: any) {
      const message = err?.message || "无法获取管理员分配的桌面配置";
      setDesktopConfig(null);
      setDesktopConfigError(message);
      if (err?.code === "unauthenticated") {
        setAuthNotice(message);
        try {
          await authService.logout();
        } catch (logoutReason) {
          setAuthNotice(
            `${message}；${
              logoutReason instanceof Error ? logoutReason.message : "本地凭据清理失败"
            }`
          );
        }
        setCurrentUser(null);
      }
      if (announce) error("同步配置失败", message);
    } finally {
      setDesktopConfigLoading(false);
    }
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
  }, [desktopRuntime, authReady, currentUser?.id]);

  const handleLoginSuccess = (user: UserAccount) => {
    setAuthNotice(null);
    setCurrentUser(user);
  };

  const handleLogout = async () => {
    let failure: string | null = null;
    try {
      await authService.logout();
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : "本地登录凭据清理失败";
    }
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
      info("已切换为代理模式", "平台访问将通过专属代理网络转发");
    } else {
      info("已切换为直连模式", "平台访问将直接使用本机网络访问");
    }
  };

  const handleOpenBrowser = async (platformId: number) => {
    try {
      const directMode = !proxyEnabled;
      await tauriBridge.openBrowser(platformId, directMode);
      if (directMode) {
        success("直连浏览器已启动", "已在新的临时浏览器环境中直接打开平台（本机直连）");
      } else {
        success("代理浏览器已启动", "已在新的临时浏览器环境中打开平台（专属代理）");
      }
    } catch (err: any) {
      error("打开浏览器失败", err.message || "请稍后重试或联系管理员");
    }
  };

  if (!desktopRuntime) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-md rounded-2xl border border-border bg-card/90 p-6 text-center shadow-2xl backdrop-blur-xl">
          <h1 className="text-lg font-semibold text-foreground">Vestus 桌面客户端</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            桌面端用户登录只能在 Tauri 客户端中使用。浏览器端仅提供管理员后台。
          </p>
          <p className="mt-4 text-xs text-muted-foreground/80">请访问管理员提供的 Web 后台地址。</p>
        </div>
      </div>
    );
  }

  if (!authReady) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-muted-foreground">
        <div className="text-sm">正在验证登录状态…</div>
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
      <div data-tauri-drag-region className="absolute top-0 left-56 right-0 h-8 z-30 select-none cursor-default" />

      <Sidebar
        productName={productName}
        logoUrl={logoUrl}
        user={currentUser}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onLogout={handleLogout}
      />

      <main className="flex-1 h-screen overflow-y-auto px-5 py-6 pt-8 sm:px-8 sm:py-7 sm:pt-8">
        {activeTab === "platforms" ? (
          <PlatformLauncher
            status={status}
            desktopConfig={desktopConfig}
            configLoading={desktopConfigLoading}
            configError={desktopConfigError}
            proxyEnabled={proxyEnabled}
            onRetryConfig={() => syncDesktopConfig(true)}
            onOpenBrowser={handleOpenBrowser}
          />
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
            onSyncConfig={() => syncDesktopConfig(true)}
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
