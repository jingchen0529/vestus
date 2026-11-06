import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { AdminProfile, ChangeAdminPasswordPayload } from "@/types/auth";
import { api, setAuthToken } from "@/lib/api-client";

interface AuthContextType {
  user: AdminProfile | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  login: (username: string, password: string) => Promise<AdminProfile>;
  logout: () => Promise<void>;
  changePassword: (payload: ChangeAdminPasswordPayload) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  // 会话变化后，忽略仍在途的旧身份请求。
  const sessionVersion = useRef(0);

  const checkAuth = useCallback(async () => {
    const version = sessionVersion.current;
    setIsLoading(true);
    try {
      const profile = await api.getMe();
      if (version === sessionVersion.current) setUser(profile);
    } catch {
      if (version === sessionVersion.current) {
        setUser(null);
        setAuthToken(null);
      }
    } finally {
      if (version === sessionVersion.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (username: string, password: string): Promise<AdminProfile> => {
    const res = await api.login({ username, password });
    if (res.admin) {
      setUser(res.admin);
      return res.admin;
    }
    const profile = await api.getMe();
    setUser(profile);
    return profile;
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  };

  const changePassword = async (payload: ChangeAdminPasswordPayload) => {
    await api.changeAdminPassword(payload);
    sessionVersion.current += 1;
    setUser(null);
    setIsLoading(false);
  };

  const refreshUser = async () => {
    const version = sessionVersion.current;
    try {
      const profile = await api.getMe();
      if (version === sessionVersion.current) setUser(profile);
    } catch {
      if (version === sessionVersion.current) setUser(null);
    }
  };

  const isSuperAdmin = user?.role === "super_admin";

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isSuperAdmin,
        login,
        logout,
        changePassword,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
