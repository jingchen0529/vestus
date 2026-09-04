import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { LoginCard } from "@/components/auth/login-card";
import { AdminLayout } from "@/components/layout/admin-layout";
import { NavTab } from "@/components/layout/sidebar";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { UsersView } from "@/components/users/users-view";
import { DesktopConfigView } from "@/components/desktop-config/desktop-config-view";
import { PlatformsView } from "@/components/platforms/platforms-view";
import { AdminsView } from "@/components/admins/admins-view";
import { LogsView } from "@/components/logs/logs-view";
import { ActivityView } from "@/components/activity/activity-view";
import { SettingsView } from "@/components/settings/settings-view";
import { Toaster } from "@/components/ui/sonner";
import { api } from "@/lib/api-client";
import { DesktopUser, UserStats, CreateUserPayload, UpdateUserPayload } from "@/types/user";
import { ProxyItem, CreateProxyPayload, UpdateProxyPayload } from "@/types/proxy";
import { PlatformItem, CreatePlatformPayload, UpdatePlatformPayload } from "@/types/platform";
import { AdminUser, CreateAdminPayload, UpdateAdminPayload } from "@/types/admin";
import { UserLogItem } from "@/types/log";
import {
  BrowserSessionFilters,
  BrowserSessionItem,
  EMPTY_BROWSER_SESSION_FILTERS,
  toBrowserSessionQuery,
} from "@/types/browser-activity";
import { Loader2, Layers } from "lucide-react";
import { toast } from "sonner";

const VALID_TABS: NavTab[] = [
  "dashboard",
  "admins",
  "users",
  "desktop",
  "platforms",
  "activity",
  "logs",
  "settings",
];

function getInitialTab(): NavTab {
  if (typeof window !== "undefined") {
    const hash = window.location.hash.replace(/^#\/?/, "").toLowerCase() as NavTab;
    if (VALID_TABS.includes(hash)) {
      return hash;
    }
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab")?.toLowerCase() as NavTab;
    if (VALID_TABS.includes(tabParam)) {
      return tabParam;
    }
    const saved = localStorage.getItem("vestus_admin_active_tab") as NavTab;
    if (VALID_TABS.includes(saved)) {
      return saved;
    }
  }
  return "dashboard";
}

export function App() {
  const { user, isLoading: authLoading, isSuperAdmin } = useAuth();

  // Active Tab with persistence
  const [currentTab, setCurrentTab] = useState<NavTab>(getInitialTab);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleTabChange = useCallback((tab: NavTab) => {
    setCurrentTab(tab);
    if (typeof window !== "undefined") {
      localStorage.setItem("vestus_admin_active_tab", tab);
      if (window.location.hash.replace(/^#\/?/, "").toLowerCase() !== tab) {
        window.history.replaceState(null, "", `#${tab}`);
      }
    }
  }, []);

  // Listen to browser Back/Forward or hash changes
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace(/^#\/?/, "").toLowerCase() as NavTab;
      if (VALID_TABS.includes(hash) && hash !== currentTab) {
        setCurrentTab(hash);
        localStorage.setItem("vestus_admin_active_tab", hash);
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [currentTab]);

  // Keep hash & storage in sync
  useEffect(() => {
    if (typeof window !== "undefined" && user) {
      localStorage.setItem("vestus_admin_active_tab", currentTab);
      if (window.location.hash.replace(/^#\/?/, "").toLowerCase() !== currentTab) {
        window.history.replaceState(null, "", `#${currentTab}`);
      }
    }
  }, [currentTab, user]);

  // Ensure non-superadmin does not stay on super-admin-only tabs
  useEffect(() => {
    if (!authLoading && user && !isSuperAdmin) {
      if (currentTab === "admins" || currentTab === "desktop" || currentTab === "settings") {
        handleTabChange("dashboard");
      }
    }
  }, [authLoading, user, isSuperAdmin, currentTab, handleTabChange]);

  // Data states
  const [users, setUsers] = useState<DesktopUser[]>([]);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState("ALL");

  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [platforms, setPlatforms] = useState<PlatformItem[]>([]);

  // Admins state
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [adminSearch, setAdminSearch] = useState("");
  const [adminStatusFilter, setAdminStatusFilter] = useState("ALL");

  // Logs state
  const [logs, setLogs] = useState<UserLogItem[]>([]);
  const [totalLogs, setTotalLogs] = useState(0);
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(10);
  const [logStatusFilter, setLogStatusFilter] = useState("ALL");

  // Browser activity state
  const [sessions, setSessions] = useState<BrowserSessionItem[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionPageSize, setSessionPageSize] = useState(50);
  const [sessionFilters, setSessionFilters] = useState<BrowserSessionFilters>(
    EMPTY_BROWSER_SESSION_FILTERS,
  );

  // 改筛选条件就回到第一页：留在第 7 页上换条件，多半只会看到空列表。
  const handleSessionFiltersChange = useCallback((next: BrowserSessionFilters) => {
    setSessionFilters(next);
    setSessionPage(1);
  }, []);

  const handleSessionPageSizeChange = useCallback((newSize: number) => {
    setSessionPageSize(newSize);
    setSessionPage(1);
  }, []);

  const handleLogPageSizeChange = useCallback((newSize: number) => {
    setLogPageSize(newSize);
    setLogPage(1);
  }, []);

  // 详情弹窗的取数函数，保持稳定引用。
  const loadSessionDetail = useCallback((id: number) => api.getBrowserSession(id), []);

  // Data Fetching Functions
  const loadUsers = useCallback(async (searchQuery?: unknown, statusQuery?: unknown) => {
    try {
      const searchVal = typeof searchQuery === "string" ? searchQuery : userSearch;
      const statusVal = typeof statusQuery === "string" ? statusQuery : userStatusFilter;
      const filter = statusVal === "ALL" ? undefined : statusVal;
      const data = await api.listUsers(searchVal.trim() || undefined, filter);
      setUsers(data);
    } catch (err: any) {
      toast.error("加载桌面用户失败", { description: err.message });
    }
  }, [userSearch, userStatusFilter]);

  const loadUserStats = useCallback(async () => {
    try {
      const stats = await api.getUserStats();
      setUserStats(stats);
    } catch {}
  }, []);

  const loadProxies = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const data = await api.listProxies();
      setProxies(data);
    } catch (err: any) {
      toast.error("加载代理池失败", { description: err.message });
    }
  }, [isSuperAdmin]);

  const loadPlatforms = useCallback(async () => {
    try {
      const data = await api.listPlatforms();
      setPlatforms(data);
    } catch (err: any) {
      toast.error("加载平台列表失败", { description: err.message });
    }
  }, []);

  const loadAdmins = useCallback(async (searchQuery?: unknown, statusQuery?: unknown) => {
    if (!isSuperAdmin) return;
    try {
      const searchVal = typeof searchQuery === "string" ? searchQuery : adminSearch;
      const statusVal = typeof statusQuery === "string" ? statusQuery : adminStatusFilter;
      const filter = statusVal === "ALL" ? undefined : statusVal;
      const data = await api.listAdmins(searchVal.trim() || undefined, filter);
      setAdmins(data);
    } catch (err: any) {
      toast.error("加载管理员列表失败", { description: err.message });
    }
  }, [adminSearch, adminStatusFilter, isSuperAdmin]);

  const loadLogs = useCallback(async (page?: any, status?: any) => {
    try {
      const pageNum = typeof page === "number" ? page : logPage;
      const statusVal = typeof status === "string" ? status : logStatusFilter;
      const filter = statusVal === "ALL" ? undefined : statusVal;
      const res = await api.listLogs({
        page: pageNum,
        pageSize: logPageSize,
        status: filter,
      });
      setLogs(res.items || []);
      setTotalLogs(res.total || 0);
    } catch (err: any) {
      toast.error("加载审计日志失败", { description: err.message });
    }
  }, [logPage, logPageSize, logStatusFilter]);

  const loadSessions = useCallback(async (page?: any, filters?: any) => {
    try {
      const pageNum = typeof page === "number" ? page : sessionPage;
      const activeFilters =
        filters && typeof filters === "object" && !("nativeEvent" in filters)
          ? filters
          : sessionFilters;
      const res = await api.listBrowserSessions({
        page: pageNum,
        pageSize: sessionPageSize,
        ...toBrowserSessionQuery(activeFilters),
      });
      setSessions(res.items || []);
      setTotalSessions(res.total || 0);
    } catch (err: any) {
      toast.error("加载浏览器活动失败", { description: err.message });
    }
  }, [sessionPage, sessionPageSize, sessionFilters]);

  // Refresh All handler
  const handleRefreshAll = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.allSettled([
        loadUsers(),
        loadUserStats(),
        loadProxies(),
        loadPlatforms(),
        loadAdmins(),
        loadLogs(),
        loadSessions(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadUsers, loadUserStats, loadProxies, loadPlatforms, loadAdmins, loadLogs, loadSessions]);

  // Initial Load on login
  useEffect(() => {
    if (user) {
      handleRefreshAll();
    }
  }, [user]);

  // User search debounce
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      loadUsers(userSearch, userStatusFilter);
    }, 250);
    return () => clearTimeout(timer);
  }, [userSearch, userStatusFilter, user]);

  // Admin search debounce
  useEffect(() => {
    if (!user || !isSuperAdmin) return;
    const timer = setTimeout(() => {
      loadAdmins(adminSearch, adminStatusFilter);
    }, 250);
    return () => clearTimeout(timer);
  }, [adminSearch, adminStatusFilter, user, isSuperAdmin]);

  // Logs filter or page change
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      loadLogs(logPage, logStatusFilter);
    }, 250);
    return () => clearTimeout(timer);
  }, [logPage, logPageSize, logStatusFilter, user]);

  // Browser activity filter or page change
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      loadSessions(sessionPage, sessionFilters);
    }, 250);
    return () => clearTimeout(timer);
  }, [sessionPage, sessionPageSize, sessionFilters, user]);

  // User Mutators
  const handleCreateUser = async (payload: CreateUserPayload) => {
    await api.createUser(payload);
    await Promise.all([loadUsers(), loadUserStats()]);
  };

  const handleUpdateUser = async (id: number, payload: UpdateUserPayload) => {
    await api.updateUser(id, payload);
    await Promise.all([loadUsers(), loadUserStats()]);
  };

  const handleToggleUserStatus = async (targetUser: DesktopUser) => {
    const isAct = targetUser.status === "active";
    if (isAct) {
      await api.disableUser(targetUser.id);
      toast.success(`用户 ${targetUser.username} 已被停用`);
    } else {
      await api.enableUser(targetUser.id);
      toast.success(`用户 ${targetUser.username} 已恢复启用`);
    }
    await Promise.all([loadUsers(), loadUserStats()]);
  };

  const handleResetUserPassword = async (id: number, pwd: string) => {
    await api.resetUserPassword(id, pwd);
  };

  const handleDeleteUser = async (targetUser: DesktopUser) => {
    await api.deleteUser(targetUser.id);
    toast.success(`用户 ${targetUser.username} 已成功删除`);
    await Promise.all([loadUsers(), loadUserStats()]);
  };

  // Proxy Mutators
  const handleCreateProxy = async (payload: CreateProxyPayload) => {
    await api.createProxy(payload);
    await loadProxies();
  };

  const handleUpdateProxy = async (id: number, payload: UpdateProxyPayload) => {
    await api.updateProxy(id, payload);
    await loadProxies();
  };

  const handleToggleProxyStatus = async (targetProxy: ProxyItem) => {
    const nextStatus = targetProxy.status === "active" ? "disabled" : "active";
    await api.updateProxy(targetProxy.id, { status: nextStatus });
    toast.success(`代理 ${targetProxy.name} 已${nextStatus === "active" ? "启用" : "停用"}`);
    await loadProxies();
  };

  const handleDeleteProxy = async (targetProxy: ProxyItem) => {
    await api.deleteProxy(targetProxy.id);
    toast.success(`代理 ${targetProxy.name} 已删除`);
    await loadProxies();
  };

  // Platform Mutators
  const handleCreatePlatform = async (payload: CreatePlatformPayload) => {
    await api.createPlatform(payload);
    await loadPlatforms();
  };

  const handleUpdatePlatform = async (id: number, payload: UpdatePlatformPayload) => {
    await api.updatePlatform(id, payload);
    await loadPlatforms();
  };

  const handleTogglePlatformStatus = async (targetPlatform: PlatformItem) => {
    const nextStatus = targetPlatform.status === "active" ? "disabled" : "active";
    await api.updatePlatform(targetPlatform.id, { status: nextStatus });
    toast.success(`平台 ${targetPlatform.name} 已${nextStatus === "active" ? "启用" : "停用"}`);
    await loadPlatforms();
  };

  const handleDeletePlatform = async (targetPlatform: PlatformItem) => {
    await api.deletePlatform(targetPlatform.id);
    toast.success(`平台 ${targetPlatform.name} 已删除`);
    await loadPlatforms();
  };

  // Admin Mutators
  const handleCreateAdmin = async (payload: CreateAdminPayload) => {
    await api.createAdmin(payload);
    await loadAdmins();
  };

  const handleUpdateAdmin = async (id: number, payload: UpdateAdminPayload) => {
    await api.updateAdmin(id, payload);
    await loadAdmins();
  };

  const handleToggleAdminStatus = async (targetAdmin: AdminUser) => {
    const isAct = targetAdmin.status === "active";
    if (isAct) {
      await api.disableAdmin(targetAdmin.id);
      toast.success(`管理员 ${targetAdmin.username} 已停用`);
    } else {
      await api.enableAdmin(targetAdmin.id);
      toast.success(`管理员 ${targetAdmin.username} 已恢复启用`);
    }
    await loadAdmins();
  };

  const handleDeleteAdmin = async (targetAdmin: AdminUser) => {
    await api.deleteAdmin(targetAdmin.id);
    toast.success(`管理员 ${targetAdmin.username} 已成功删除`);
    await loadAdmins();
  };

  const handleResetAdminPassword = async (id: number, pwd: string) => {
    await api.resetAdminPassword(id, pwd);
  };

  // If initial auth check is ongoing
  if (authLoading) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-slate-950 text-slate-100">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/30 animate-pulse mb-4">
          <Layers className="h-7 w-7 text-white" />
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span>正在验证安全管理凭证...</span>
        </div>
      </div>
    );
  }

  // If not logged in, render Login View
  if (!user) {
    return (
      <>
        <LoginCard />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <AdminLayout
        currentTab={currentTab}
        onTabChange={handleTabChange}
        onRefreshCurrent={handleRefreshAll}
        isRefreshing={isRefreshing}
        userStatsTotal={userStats?.total}
        platformsTotal={platforms.length}
        proxiesTotal={proxies.length}
      >
        {/* Tab 1: Dashboard Overview */}
        {currentTab === "dashboard" && (
          <DashboardView
            userStats={userStats}
            proxies={proxies}
            platforms={platforms}
            admins={admins}
            recentLogs={logs}
            onNavigate={handleTabChange}
            onOpenCreateUser={() => handleTabChange("users")}
            onOpenCreateProxy={() => handleTabChange("desktop")}
            onOpenCreatePlatform={() => handleTabChange("platforms")}
            onOpenCreateAdmin={isSuperAdmin ? () => handleTabChange("admins") : undefined}
          />
        )}

        {/* Tab 2: Users Management */}
        {currentTab === "users" && (
          <UsersView
            users={users}
            search={userSearch}
            onSearchChange={setUserSearch}
            statusFilter={userStatusFilter}
            onStatusFilterChange={setUserStatusFilter}
            onRefresh={() => loadUsers()}
            isRefreshing={isRefreshing}
            onCreateUser={handleCreateUser}
            onUpdateUser={handleUpdateUser}
            onToggleUserStatus={handleToggleUserStatus}
            onResetPassword={handleResetUserPassword}
            onDeleteUser={handleDeleteUser}
          />
        )}

        {/* Tab 3: Unified Proxy Management */}
        {currentTab === "desktop" && isSuperAdmin && (
          <DesktopConfigView
            proxies={proxies}
            onRefresh={() => loadProxies()}
            isRefreshing={isRefreshing}
            onCreateProxy={handleCreateProxy}
            onUpdateProxy={handleUpdateProxy}
            onToggleProxyStatus={handleToggleProxyStatus}
            onDeleteProxy={handleDeleteProxy}
          />
        )}

        {/* Tab 4: Platform Management */}
        {currentTab === "platforms" && (
          <PlatformsView
            platforms={platforms}
            onRefresh={() => loadPlatforms()}
            isRefreshing={isRefreshing}
            onCreatePlatform={handleCreatePlatform}
            onUpdatePlatform={handleUpdatePlatform}
            onTogglePlatformStatus={handleTogglePlatformStatus}
            onDeletePlatform={handleDeletePlatform}
          />
        )}

        {/* Tab 4: Administrators Management */}
        {currentTab === "admins" && isSuperAdmin && (
          <AdminsView
            admins={admins}
            search={adminSearch}
            onSearchChange={setAdminSearch}
            statusFilter={adminStatusFilter}
            onStatusFilterChange={setAdminStatusFilter}
            onRefresh={() => loadAdmins()}
            isRefreshing={isRefreshing}
            onCreateAdmin={handleCreateAdmin}
            onUpdateAdmin={handleUpdateAdmin}
            onToggleAdminStatus={handleToggleAdminStatus}
            onResetPassword={handleResetAdminPassword}
            onDeleteAdmin={handleDeleteAdmin}
          />
        )}

        {/* Tab 5: Browser Activity */}
        {currentTab === "activity" && (
          <ActivityView
            sessions={sessions}
            totalSessions={totalSessions}
            currentPage={sessionPage}
            pageSize={sessionPageSize}
            onPageChange={setSessionPage}
            onPageSizeChange={handleSessionPageSizeChange}
            filters={sessionFilters}
            onFiltersChange={handleSessionFiltersChange}
            users={users}
            platforms={platforms}
            onRefresh={() => loadSessions()}
            isRefreshing={isRefreshing}
            onLoadDetail={loadSessionDetail}
          />
        )}

        {/* Tab 6: Audit Logs */}
        {currentTab === "logs" && (
          <LogsView
            logs={logs}
            totalLogs={totalLogs}
            currentPage={logPage}
            pageSize={logPageSize}
            onPageChange={setLogPage}
            onPageSizeChange={handleLogPageSizeChange}
            statusFilter={logStatusFilter}
            onStatusFilterChange={setLogStatusFilter}
            onRefresh={() => loadLogs()}
            isRefreshing={isRefreshing}
          />
        )}

        {/* Tab 6: System Configuration (Brand & Theme) */}
        {currentTab === "settings" && isSuperAdmin && <SettingsView />}
      </AdminLayout>

      <Toaster />
    </>
  );
}
