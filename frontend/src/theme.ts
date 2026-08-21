// Client-side theme preference. Themes are pure CSS (see [data-theme] blocks
// in styles.css); we just toggle the attribute on <html> and remember the
// choice in localStorage. Default is the Light theme.

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

export const DEFAULT_THEME: ThemeId = "dark";

const STORAGE_KEY = "drc-theme";

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
