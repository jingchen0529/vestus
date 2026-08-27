import React, { useState, useEffect } from "react";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { Header } from "@/components/layout/Header";
import { LoginCard } from "@/components/auth/LoginCard";
import { ChangePasswordCard } from "@/components/auth/ChangePasswordCard";
import { PlatformLauncher } from "@/components/browser/PlatformLauncher";
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
  const [desktopConfig, setDesktopConfig] = useState<DesktopConfigView | null>(null);
  const [desktopConfigLoading, setDesktopConfigLoading] = useState(false);
  const [desktopConfigError, setDesktopConfigError] = useState<string | null>(null);

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
    void authService.getProductName().then((name) => {
      if (mounted) setProductName(name);
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
      currentUser.mustChangePassword ||
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
  }, [desktopRuntime, authReady, currentUser?.id, currentUser?.mustChangePassword]);

  const syncDesktopConfig = async (announce = false) => {
    if (
      !desktopRuntime ||
      !currentUser ||
      currentUser.mustChangePassword ||
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
      currentUser.mustChangePassword ||
      !authService.isAuthenticated()
    ) {
      return;
    }
    void syncDesktopConfig(false);
  }, [desktopRuntime, authReady, currentUser?.id, currentUser?.mustChangePassword]);

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

  const handleOpenBrowser = async (platformId: number) => {
    try {
      await tauriBridge.openBrowser(platformId);
      success("代理浏览器已启动", "已在新的临时浏览器环境中打开平台");
    } catch (err: any) {
      error("打开浏览器失败", err.message || "请稍后重试或联系管理员");
    }
  };

  if (!desktopRuntime) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-950 p-6 text-slate-200">
        <div className="max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-center shadow-2xl">
          <h1 className="text-lg font-semibold text-white">Vestus 桌面客户端</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            桌面端用户登录只能在 Tauri 客户端中使用。浏览器端仅提供管理员后台。
          </p>
          <p className="mt-4 text-xs text-slate-500">请访问管理员提供的 Web 后台地址。</p>
        </div>
      </div>
    );
  }

  if (!authReady) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-950 text-slate-300">
        <div className="text-sm">正在验证登录状态…</div>
      </div>
    );
  }

  // 未登录时展示登录页
  if (!currentUser || !authService.isAuthenticated()) {
    return (
      <LoginCard
        productName={productName}
        notice={authNotice}
        onLoginSuccess={handleLoginSuccess}
      />
    );
  }

  if (currentUser.mustChangePassword) {
    return (
      <ChangePasswordCard
        username={currentUser.username}
        onLogout={handleLogout}
        onPasswordChanged={() => {
          setAuthNotice(null);
          setCurrentUser(null);
          setDesktopConfig(null);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      <Header
        productName={productName}
        user={currentUser}
        onLogout={handleLogout}
      />

      <main className="flex-1 overflow-y-auto px-5 py-8 sm:px-8 sm:py-10">
        <PlatformLauncher
          status={status}
          desktopConfig={desktopConfig}
          configLoading={desktopConfigLoading}
          configError={desktopConfigError}
          onRetryConfig={() => syncDesktopConfig(true)}
          onOpenBrowser={handleOpenBrowser}
        />
      </main>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <MainLayout />
    </ToastProvider>
  );
}

export default App;
