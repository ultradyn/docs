import { Monitor, Moon, Sun } from "lucide-react";

import type { ThemePreference } from "../theme.js";

const ORDER: ThemePreference[] = ["system", "light", "dark"];

const LABELS: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

const ICONS: Record<ThemePreference, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

interface ThemeToggleProps {
  preference: ThemePreference;
  onChange: (next: ThemePreference) => void;
}

/** Small sidebar toggle that cycles system → light → dark. */
export function ThemeToggle({ preference, onChange }: ThemeToggleProps) {
  const Icon = ICONS[preference];
  const currentIndex = ORDER.indexOf(preference);
  const next =
    ORDER[(currentIndex + 1) % ORDER.length] ?? ORDER[0] ?? "system";
  return (
    <button
      type="button"
      className="theme-toggle"
      title={`${LABELS[preference]} — click for ${LABELS[next].toLowerCase()}`}
      aria-label={`${LABELS[preference]}. Activate to switch to ${LABELS[next].toLowerCase()}.`}
      onClick={() => onChange(next)}
    >
      <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
      <span>{LABELS[preference].replace(" theme", "")}</span>
    </button>
  );
}
