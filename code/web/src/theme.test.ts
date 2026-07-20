// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  THEME_SETTING_KEY,
  applyResolvedTheme,
  parseThemePreference,
  resolveTheme,
  systemPrefersDark,
  themeFromSettingsValues,
} from "./theme.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  vi.restoreAllMocks();
});

describe("theme preference", () => {
  it("parses known theme preferences and defaults unknowns to system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("sepia")).toBe("system");
    expect(parseThemePreference(undefined)).toBe("system");
  });

  it("resolves system against the current color-scheme preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("applies data-theme and color-scheme on the document root", () => {
    applyResolvedTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyResolvedTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("reads appearance.theme from settings values", () => {
    expect(
      themeFromSettingsValues({ [THEME_SETTING_KEY]: "dark" }, false),
    ).toBe("dark");
    expect(
      themeFromSettingsValues({ [THEME_SETTING_KEY]: "system" }, true),
    ).toBe("dark");
    expect(themeFromSettingsValues({}, false)).toBe("light");
  });

  it("detects system dark preference from matchMedia", () => {
    expect(systemPrefersDark({ matches: true })).toBe(true);
    expect(systemPrefersDark({ matches: false })).toBe(false);
  });
});
