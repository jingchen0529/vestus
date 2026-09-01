import React, { createContext, useContext, useEffect, useState } from "react";
import defaultLogo from "@/assets/logo.png";
import { api } from "@/lib/api-client";

export type Theme = "dark" | "light" | "system";

export type AccentColor =
  | "blue"
  | "indigo"
  | "purple"
  | "emerald"
  | "amber"
  | "rose"
  | "cyan";

export interface AccentColorPreset {
  id: AccentColor;
  label: string;
  colorHex: string;
  primaryLight: string;
  primaryDark: string;
  ringLight: string;
  ringDark: string;
}

export const ACCENT_COLOR_PRESETS: Record<AccentColor, AccentColorPreset> = {
  blue: {
    id: "blue",
    label: "经典蓝",
    colorHex: "#3b82f6",
    primaryLight: "221.2 83.2% 53.3%",
    primaryDark: "217.2 91.2% 59.8%",
    ringLight: "221.2 83.2% 53.3%",
    ringDark: "224.3 76.3% 48%",
  },
  indigo: {
    id: "indigo",
    label: "星空靛",
    colorHex: "#6366f1",
    primaryLight: "238.7 83.5% 58.4%",
    primaryDark: "234.5 89.5% 63.9%",
    ringLight: "238.7 83.5% 58.4%",
    ringDark: "234.5 89.5% 63.9%",
  },
  purple: {
    id: "purple",
    label: "极光紫",
    colorHex: "#8b5cf6",
    primaryLight: "262.1 83.3% 57.8%",
    primaryDark: "263.4 70% 50.4%",
    ringLight: "262.1 83.3% 57.8%",
    ringDark: "263.4 70% 50.4%",
  },
  emerald: {
    id: "emerald",
    label: "翡翠绿",
    colorHex: "#10b981",
    primaryLight: "158.1 64.4% 41.6%",
    primaryDark: "160 84.1% 39.4%",
    ringLight: "158.1 64.4% 41.6%",
    ringDark: "160 84.1% 39.4%",
  },
  amber: {
    id: "amber",
    label: "琥珀金",
    colorHex: "#f59e0b",
    primaryLight: "37.7 92.1% 50.2%",
    primaryDark: "45 93.4% 47.3%",
    ringLight: "37.7 92.1% 50.2%",
    ringDark: "45 93.4% 47.3%",
  },
  rose: {
    id: "rose",
    label: "珊瑚粉",
    colorHex: "#f43f5e",
    primaryLight: "346.8 77.2% 49.8%",
    primaryDark: "349.7 89.2% 60.2%",
    ringLight: "346.8 77.2% 49.8%",
    ringDark: "349.7 89.2% 60.2%",
  },
  cyan: {
    id: "cyan",
    label: "苍穹青",
    colorHex: "#06b6d4",
    primaryLight: "188.7 94.5% 42.7%",
    primaryDark: "187 92.4% 45%",
    ringLight: "188.7 94.5% 42.7%",
    ringDark: "187 92.4% 45%",
  },
};

type BrandingStorage = Pick<Storage, "setItem" | "removeItem">;

type BrandingStorageKeys = {
  title: string;
  logo: string;
  accent: string;
};

type PublicBranding = {
  adminTitle: string;
  adminLogoUrl: string;
  adminThemeColor: AccentColor | null;
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function syncPublicBranding(
  payload: Record<string, unknown>,
  storage: BrandingStorage,
  keys: BrandingStorageKeys,
): PublicBranding {
  const adminTitle = nonEmptyString(payload.adminTitle) || "Vestus 管理后台";
  const adminLogoUrl =
    nonEmptyString(payload.adminLogoUrl) || nonEmptyString(payload.logoUrl);
  const accentCandidate = nonEmptyString(payload.adminThemeColor);
  const adminThemeColor = Object.prototype.hasOwnProperty.call(
    ACCENT_COLOR_PRESETS,
    accentCandidate,
  )
    ? (accentCandidate as AccentColor)
    : null;

  try {
    storage.setItem(keys.title, adminTitle);
    if (adminLogoUrl) storage.setItem(keys.logo, adminLogoUrl);
    else storage.removeItem(keys.logo);
    if (adminThemeColor) storage.setItem(keys.accent, adminThemeColor);
  } catch {
    // Storage may be unavailable in hardened/private browser contexts.
  }

  return { adminTitle, adminLogoUrl, adminThemeColor };
}

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  defaultAccent?: AccentColor;
  storageKey?: string;
  accentStorageKey?: string;
  titleStorageKey?: string;
  logoStorageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accentColor: AccentColor;
  setAccentColor: (color: AccentColor) => void;
  adminTitle: string;
  setAdminTitle: (title: string) => void;
  adminLogoUrl: string;
  setAdminLogoUrl: (logo: string) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
  accentColor: "blue",
  setAccentColor: () => null,
  adminTitle: "Vestus 管理后台",
  setAdminTitle: () => null,
  adminLogoUrl: "",
  setAdminLogoUrl: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = "light",
  defaultAccent = "blue",
  storageKey = "vestus-admin-ui-theme",
  accentStorageKey = "vestus-admin-ui-accent",
  titleStorageKey = "vestus-admin-ui-title",
  logoStorageKey = "vestus-admin-ui-logo",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(storageKey) as Theme) || defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  const [accentColor, setAccentColor] = useState<AccentColor>(() => {
    try {
      return (localStorage.getItem(accentStorageKey) as AccentColor) || defaultAccent;
    } catch {
      return defaultAccent;
    }
  });

  const [adminTitle, setAdminTitleState] = useState<string>(() => {
    try {
      return localStorage.getItem(titleStorageKey) || "Vestus 管理后台";
    } catch {
      return "Vestus 管理后台";
    }
  });

  const [adminLogoUrl, setAdminLogoUrlState] = useState<string>(() => {
    try {
      return localStorage.getItem(logoStorageKey) || "";
    } catch {
      return "";
    }
  });

  // Apply light/dark classes and primary theme colors
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    let isDark = false;
    if (theme === "system") {
      isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.add(isDark ? "dark" : "light");
    } else {
      isDark = theme === "dark";
      root.classList.add(theme);
    }

    // Apply primary color CSS variables
    const preset = ACCENT_COLOR_PRESETS[accentColor] || ACCENT_COLOR_PRESETS.blue;
    const primaryHsl = isDark ? preset.primaryDark : preset.primaryLight;
    const ringHsl = isDark ? preset.ringDark : preset.ringLight;

    root.style.setProperty("--primary", primaryHsl);
    root.style.setProperty("--ring", ringHsl);
  }, [theme, accentColor]);

  // Synchronize document.title dynamically with system configuration
  useEffect(() => {
    if (adminTitle && adminTitle.trim()) {
      document.title = adminTitle.trim();
    } else {
      document.title = "Vestus 管理后台";
    }
  }, [adminTitle]);

  // Synchronize browser tab favicon dynamically with system configuration
  useEffect(() => {
    const targetHref = adminLogoUrl && adminLogoUrl.trim() ? adminLogoUrl.trim() : defaultLogo;
    let link: HTMLLinkElement | null = document.querySelector("link[rel*='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = targetHref.endsWith(".ico")
      ? "image/x-icon"
      : targetHref.endsWith(".svg")
        ? "image/svg+xml"
        : "image/png";
    link.href = targetHref;
  }, [adminLogoUrl]);

  // Initial fetch of system settings from backend
  useEffect(() => {
    api.getProduct()
      .then((res) => {
        const branding = syncPublicBranding(res, localStorage, {
          title: titleStorageKey,
          logo: logoStorageKey,
          accent: accentStorageKey,
        });
        setAdminTitleState(branding.adminTitle);
        setAdminLogoUrlState(branding.adminLogoUrl);
        if (branding.adminThemeColor) setAccentColor(branding.adminThemeColor);
      })
      .catch(() => {});
  }, [titleStorageKey, logoStorageKey, accentStorageKey]);

  const value: ThemeProviderState = {
    theme,
    setTheme: (newTheme: Theme) => {
      try {
        localStorage.setItem(storageKey, newTheme);
      } catch {}
      setTheme(newTheme);
    },
    accentColor,
    setAccentColor: (newAccent: AccentColor) => {
      try {
        localStorage.setItem(accentStorageKey, newAccent);
      } catch {}
      setAccentColor(newAccent);
    },
    adminTitle,
    setAdminTitle: (newTitle: string) => {
      try {
        localStorage.setItem(titleStorageKey, newTitle);
      } catch {}
      setAdminTitleState(newTitle);
    },
    adminLogoUrl,
    setAdminLogoUrl: (newLogo: string) => {
      try {
        localStorage.setItem(logoStorageKey, newLogo);
      } catch {}
      setAdminLogoUrlState(newLogo);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");
  return context;
};
