import React from "react";
import { Sun, Moon, Laptop } from "lucide-react";
import { useTheme, Theme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  variant?: "segmented" | "compact" | "icon-button";
  className?: string;
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({
  variant = "segmented",
  className,
}) => {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();

  if (variant === "icon-button") {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shadow-sm",
          className
        )}
        title={
          theme === "dark"
            ? "当前：暗黑模式（点击切换为跟随系统）"
            : theme === "light"
            ? "当前：明亮模式（点击切换为暗黑模式）"
            : "当前：跟随系统（点击切换为明亮模式）"
        }
      >
        {theme === "system" ? (
          <Laptop className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
        ) : resolvedTheme === "dark" ? (
          <Moon className="h-3.5 w-3.5 text-sky-400" />
        ) : (
          <Sun className="h-3.5 w-3.5 text-amber-500" />
        )}
      </button>
    );
  }

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-1 rounded-lg border border-border/80 bg-muted/50 p-0.5 shadow-sm",
          className
        )}
      >
        <button
          type="button"
          onClick={() => setTheme("light")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-xs transition-all",
            theme === "light"
              ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
              : "text-muted-foreground hover:text-foreground hover:bg-card/40"
          )}
          title="明亮模式"
        >
          <Sun className={cn("h-3.5 w-3.5", theme === "light" ? "text-amber-500" : "")} />
        </button>
        <button
          type="button"
          onClick={() => setTheme("dark")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-xs transition-all",
            theme === "dark"
              ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
              : "text-muted-foreground hover:text-foreground hover:bg-card/40"
          )}
          title="暗黑模式"
        >
          <Moon className={cn("h-3.5 w-3.5", theme === "dark" ? "text-sky-400" : "")} />
        </button>
        <button
          type="button"
          onClick={() => setTheme("system")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-xs transition-all",
            theme === "system"
              ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
              : "text-muted-foreground hover:text-foreground hover:bg-card/40"
          )}
          title="跟随系统"
        >
          <Laptop className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-border/70 bg-muted/60 p-0.5 shadow-sm",
        className
      )}
    >
      <button
        type="button"
        onClick={() => setTheme("light")}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all",
          theme === "light"
            ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
            : "text-muted-foreground hover:text-foreground hover:bg-card/40"
        )}
        title="明亮模式"
      >
        <Sun className={cn("h-3.5 w-3.5", theme === "light" ? "text-amber-500" : "")} />
        <span className="hidden sm:inline text-[11px]">明亮</span>
      </button>
      <button
        type="button"
        onClick={() => setTheme("dark")}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all",
          theme === "dark"
            ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
            : "text-muted-foreground hover:text-foreground hover:bg-card/40"
        )}
        title="暗黑模式"
      >
        <Moon className={cn("h-3.5 w-3.5", theme === "dark" ? "text-sky-400" : "")} />
        <span className="hidden sm:inline text-[11px]">暗黑</span>
      </button>
      <button
        type="button"
        onClick={() => setTheme("system")}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all",
          theme === "system"
            ? "bg-card text-foreground shadow-sm font-semibold border border-border/60"
            : "text-muted-foreground hover:text-foreground hover:bg-card/40"
        )}
        title="跟随系统"
      >
        <Laptop className="h-3.5 w-3.5" />
        <span className="hidden sm:inline text-[11px]">系统</span>
      </button>
    </div>
  );
};
