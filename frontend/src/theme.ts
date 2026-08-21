// Which palette Nox wears.
//
// Themes are pure CSS — [data-theme] blocks in styles.css. This only flips the
// attribute on <html> and remembers the choice.
//
// Midnight is the default, and it is the one Nox was named for: a blue-black
// ground rather than the pure black of Dark, so panels, cards and borders
// separate from the page by tone instead of by outline.

export type ThemeId = "light" | "dark" | "midnight";

export interface ThemeDef {
  id: ThemeId;
  label: string;
  // A small swatch (page bg / accent) for the picker.
  swatch: { bg: string; fg: string };
}

export const THEMES: ThemeDef[] = [
  { id: "light", label: "Light", swatch: { bg: "#f3f4f6", fg: "#3b6fff" } },
  { id: "dark", label: "Dark", swatch: { bg: "#000000", fg: "#5b8cff" } },
  { id: "midnight", label: "Midnight", swatch: { bg: "#0e1116", fg: "#5b8cff" } },
];

export const DEFAULT_THEME: ThemeId = "midnight";

// Nox's own key. Sharing the old one would mean a preference set in a
// different product silently deciding how this one looks.
const STORAGE_KEY = "nox-theme";

export function getTheme(): ThemeId {
  try {
    const t = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (t && THEMES.some((x) => x.id === t)) return t;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute("data-theme", id);
}

export function setTheme(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  applyTheme(id);
}
