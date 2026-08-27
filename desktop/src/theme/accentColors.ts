export type AccentColor =
  | "blue"
  | "indigo"
  | "purple"
  | "emerald"
  | "amber"
  | "rose"
  | "cyan";

export interface AccentColorPreset {
  label: string;
  colorHex: string;
  primaryLight: string;
  primaryDark: string;
  foregroundLight: string;
  foregroundDark: string;
  ringLight: string;
  ringDark: string;
}

export const ACCENT_COLOR_PRESETS: Record<AccentColor, AccentColorPreset> = {
  blue: {
    label: "经典蓝",
    colorHex: "#3b82f6",
    primaryLight: "221.2 83.2% 53.3%",
    primaryDark: "217.2 91.2% 59.8%",
    foregroundLight: "0 0% 100%",
    foregroundDark: "222.2 47.4% 11.2%",
    ringLight: "221.2 83.2% 53.3%",
    ringDark: "224.3 76.3% 48%",
  },
  indigo: {
    label: "星空靛",
    colorHex: "#6366f1",
    primaryLight: "238.7 83.5% 58.4%",
    primaryDark: "234.5 89.5% 63.9%",
    foregroundLight: "0 0% 100%",
    foregroundDark: "0 0% 100%",
    ringLight: "238.7 83.5% 58.4%",
    ringDark: "234.5 89.5% 63.9%",
  },
  purple: {
    label: "极光紫",
    colorHex: "#8b5cf6",
    primaryLight: "262.1 83.3% 57.8%",
    primaryDark: "263.4 70% 50.4%",
    foregroundLight: "0 0% 100%",
    foregroundDark: "0 0% 100%",
    ringLight: "262.1 83.3% 57.8%",
    ringDark: "263.4 70% 50.4%",
  },
  emerald: {
    label: "翡翠绿",
    colorHex: "#10b981",
    primaryLight: "158.1 64.4% 41.6%",
    primaryDark: "160 84.1% 39.4%",
    foregroundLight: "222.2 47.4% 11.2%",
    foregroundDark: "222.2 47.4% 11.2%",
    ringLight: "158.1 64.4% 41.6%",
    ringDark: "160 84.1% 39.4%",
  },
  amber: {
    label: "琥珀金",
    colorHex: "#f59e0b",
    primaryLight: "37.7 92.1% 50.2%",
    primaryDark: "45 93.4% 47.3%",
    foregroundLight: "222.2 47.4% 11.2%",
    foregroundDark: "222.2 47.4% 11.2%",
    ringLight: "37.7 92.1% 50.2%",
    ringDark: "45 93.4% 47.3%",
  },
  rose: {
    label: "珊瑚粉",
    colorHex: "#f43f5e",
    primaryLight: "346.8 77.2% 49.8%",
    primaryDark: "349.7 89.2% 60.2%",
    foregroundLight: "0 0% 100%",
    foregroundDark: "222.2 47.4% 11.2%",
    ringLight: "346.8 77.2% 49.8%",
    ringDark: "349.7 89.2% 60.2%",
  },
  cyan: {
    label: "苍穹青",
    colorHex: "#06b6d4",
    primaryLight: "188.7 94.5% 42.7%",
    primaryDark: "187 92.4% 45%",
    foregroundLight: "222.2 47.4% 11.2%",
    foregroundDark: "222.2 47.4% 11.2%",
    ringLight: "188.7 94.5% 42.7%",
    ringDark: "187 92.4% 45%",
  },
};

export function resolveAccentColor(
  value: unknown,
  theme: "light" | "dark",
): { accentColor: AccentColor; primary: string; foreground: string; ring: string } {
  const accentColor: AccentColor =
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ACCENT_COLOR_PRESETS, value)
      ? (value as AccentColor)
      : "blue";
  const preset = ACCENT_COLOR_PRESETS[accentColor];

  return {
    accentColor,
    primary: theme === "dark" ? preset.primaryDark : preset.primaryLight,
    foreground:
      theme === "dark" ? preset.foregroundDark : preset.foregroundLight,
    ring: theme === "dark" ? preset.ringDark : preset.ringLight,
  };
}
