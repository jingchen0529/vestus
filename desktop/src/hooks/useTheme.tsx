import React, { createContext, useContext, useEffect, useState } from "react";
import {
  AccentColor,
  resolveAccentColor,
} from "@/theme/accentColors";

export type Theme = "dark" | "light" | "system";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  defaultAccent?: AccentColor;
  storageKey?: string;
  accentStorageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  accentColor: AccentColor;
  setAccentColor: (accentColor: AccentColor) => void;
};

const initialState: ThemeProviderState = {
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => null,
  toggleTheme: () => null,
  accentColor: "blue",
  setAccentColor: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

const syncTauriWindowTheme = async (activeTheme: "dark" | "light") => {
  if (typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__)) {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const appWindow = getCurrentWebviewWindow();
      if (appWindow && typeof appWindow.setTheme === "function") {
        await appWindow.setTheme(activeTheme === "dark" ? "dark" : "light");
      }
    } catch {
      // Non-fatal if setting window theme fails
    }
  }
};

export function ThemeProvider({
  children,
  defaultTheme = "light",
  defaultAccent = "blue",
  storageKey = "vestus-desktop-theme",
  accentStorageKey = "vestus-desktop-accent",
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(storageKey) as Theme) || defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() => {
    if (theme === "system") {
      return typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return theme;
  });

  const [accentColor, setAccentColorState] = useState<AccentColor>(() => {
    try {
      const storedAccent = localStorage.getItem(accentStorageKey) || defaultAccent;
      return resolveAccentColor(storedAccent, "light").accentColor;
    } catch {
      return defaultAccent;
    }
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    const updateResolvedTheme = () => {
      let activeTheme: "dark" | "light";
      if (theme === "system") {
        activeTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      } else {
        activeTheme = theme;
      }
      setResolvedTheme(activeTheme);
      root.classList.remove("light", "dark");
      root.classList.add(activeTheme);
      const accent = resolveAccentColor(accentColor, activeTheme);
      root.style.setProperty("--primary", accent.primary);
      root.style.setProperty("--primary-foreground", accent.foreground);
      root.style.setProperty("--ring", accent.ring);
      void syncTauriWindowTheme(activeTheme);
    };

    updateResolvedTheme();

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme === "system") {
        updateResolvedTheme();
      }
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    } else {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, [theme, accentColor]);

  const setTheme = (newTheme: Theme) => {
    try {
      localStorage.setItem(storageKey, newTheme);
    } catch {}
    setThemeState(newTheme);
  };

  const toggleTheme = () => {
    if (theme === "light") {
      setTheme("dark");
    } else if (theme === "dark") {
      setTheme("system");
    } else {
      setTheme("light");
    }
  };

  const setAccentColor = (newAccentColor: AccentColor) => {
    try {
      localStorage.setItem(accentStorageKey, newAccentColor);
    } catch {}
    setAccentColorState(newAccentColor);
  };

  const value = {
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
    accentColor,
    setAccentColor,
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
