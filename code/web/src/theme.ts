export const THEME_SETTING_KEY = "appearance.theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

export function systemPrefersDark(
  media: Pick<MediaQueryList, "matches"> = typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : { matches: false },
): boolean {
  return media.matches;
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

export function applyResolvedTheme(
  theme: ResolvedTheme,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function themeFromSettingsValues(
  values: Record<string, unknown> | undefined,
  prefersDark: boolean = systemPrefersDark(),
): ResolvedTheme {
  return resolveTheme(
    parseThemePreference(values?.[THEME_SETTING_KEY]),
    prefersDark,
  );
}
