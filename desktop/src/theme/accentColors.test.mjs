import assert from "node:assert/strict";
import test from "node:test";

import { resolveAccentColor } from "./accentColors.ts";

test("resolves the selected accent for the active light or dark theme", () => {
  assert.deepEqual(resolveAccentColor("emerald", "light"), {
    accentColor: "emerald",
    primary: "158.1 64.4% 41.6%",
    foreground: "222.2 47.4% 11.2%",
    ring: "158.1 64.4% 41.6%",
  });
  assert.deepEqual(resolveAccentColor("emerald", "dark"), {
    accentColor: "emerald",
    primary: "160 84.1% 39.4%",
    foreground: "222.2 47.4% 11.2%",
    ring: "160 84.1% 39.4%",
  });
});

test("falls back to classic blue when persisted accent data is invalid", () => {
  assert.deepEqual(resolveAccentColor("not-a-color", "light"), {
    accentColor: "blue",
    primary: "221.2 83.2% 53.3%",
    foreground: "0 0% 100%",
    ring: "221.2 83.2% 53.3%",
  });
  assert.deepEqual(resolveAccentColor("toString", "dark"), {
    accentColor: "blue",
    primary: "217.2 91.2% 59.8%",
    foreground: "222.2 47.4% 11.2%",
    ring: "224.3 76.3% 48%",
  });
});

test("keeps text on every primary color at accessible contrast", () => {
  const colors = ["blue", "indigo", "purple", "emerald", "amber", "rose", "cyan"];

  for (const theme of ["light", "dark"]) {
    for (const color of colors) {
      const resolved = resolveAccentColor(color, theme);
      assert.ok("foreground" in resolved, `${color}/${theme} must provide a foreground`);
      assert.ok(
        contrastRatio(resolved.primary, resolved.foreground) >= 4.5,
        `${color}/${theme} primary text must meet WCAG AA contrast`,
      );
    }
  }
});

function contrastRatio(backgroundHsl, foregroundHsl) {
  const background = relativeLuminance(hslToRgb(backgroundHsl));
  const foreground = relativeLuminance(hslToRgb(foregroundHsl));
  const lighter = Math.max(background, foreground);
  const darker = Math.min(background, foreground);
  return (lighter + 0.05) / (darker + 0.05);
}

function hslToRgb(value) {
  const match = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  assert.ok(match, `invalid HSL value: ${value}`);
  const [, hueText, saturationText, lightnessText] = match;
  const hue = Number(hueText) / 360;
  const saturation = Number(saturationText) / 100;
  const lightness = Number(lightnessText) / 100;

  if (saturation === 0) return [lightness, lightness, lightness];
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hue + 1 / 3, hue, hue - 1 / 3].map((channel) => {
    let normalized = channel;
    if (normalized < 0) normalized += 1;
    if (normalized > 1) normalized -= 1;
    if (normalized < 1 / 6) return p + (q - p) * 6 * normalized;
    if (normalized < 1 / 2) return q;
    if (normalized < 2 / 3) return p + (q - p) * (2 / 3 - normalized) * 6;
    return p;
  });
}

function relativeLuminance(rgb) {
  const [red, green, blue] = rgb.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
