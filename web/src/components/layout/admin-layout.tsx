import React, { useState } from "react";
import { Sidebar, NavTab } from "./sidebar";
import { Header } from "./header";
import { ChangePasswordDialog } from "@/components/auth/change-password-dialog";

interface AdminLayoutProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onRefreshCurrent: () => void;
  isRefreshing?: boolean;
  userStatsTotal?: number;
  platformsTotal?: number;
  proxiesTotal?: number;
  expiredBindingsCount?: number;
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
  expiredBindingsCount,
  children,
}: AdminLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Collapsible Sidebar */}
      <Sidebar
        currentTab={currentTab}
        onTabChange={onTabChange}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(!collapsed)}
        onChangePassword={() => setChangePasswordOpen(true)}
        userStatsTotal={userStatsTotal}
        platformsTotal={platformsTotal}
        proxiesTotal={proxiesTotal}
        expiredBindingsCount={expiredBindingsCount}
      />

      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />

      {/* Main Container */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top Header */}
        <Header
          currentTab={currentTab}
          onRefreshCurrent={onRefreshCurrent}
          isRefreshing={isRefreshing}
        />

        {/* Scrollable View Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 bg-muted/40">
          <div className="w-full space-y-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
