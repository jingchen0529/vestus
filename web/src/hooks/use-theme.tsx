import React, { createContext, useContext, useEffect, useState } from "react";

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

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  defaultAccent?: AccentColor;
  storageKey?: string;
  accentStorageKey?: string;
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
  adminTitle: "Vestus Admin",
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

  const [adminTitle, setAdminTitle] = useState("Vestus Admin");
  const [adminLogoUrl, setAdminLogoUrl] = useState("");

  // Apply light/dark classes
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
    setAdminTitle,
    adminLogoUrl,
    setAdminLogoUrl,
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
