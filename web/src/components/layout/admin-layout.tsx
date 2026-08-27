import React, { useState } from "react";
import { Sidebar, NavTab } from "./sidebar";
import { Header } from "./header";

interface AdminLayoutProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onRefreshCurrent: () => void;
  isRefreshing?: boolean;
  userStatsTotal?: number;
  platformsTotal?: number;
  proxiesTotal?: number;
  children: React.ReactNode;
}

export function AdminLayout({
  currentTab,
  onTabChange,
  onRefreshCurrent,
  isRefreshing = false,
  userStatsTotal,
  platformsTotal,
  proxiesTotal,
  children,
}: AdminLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Collapsible Sidebar */}
      <Sidebar
        currentTab={currentTab}
        onTabChange={onTabChange}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(!collapsed)}
        userStatsTotal={userStatsTotal}
        platformsTotal={platformsTotal}
        proxiesTotal={proxiesTotal}
      />

      {/* Main Container */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top Header */}
        <Header
          currentTab={currentTab}
          onRefreshCurrent={onRefreshCurrent}
          isRefreshing={isRefreshing}
        />

        {/* Scrollable View Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 bg-slate-50/50 dark:bg-slate-950/20">
          <div className="mx-auto max-w-7xl space-y-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
