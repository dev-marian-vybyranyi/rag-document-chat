import { createContext, useContext } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'theme';
export const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

export interface ThemeContextValue {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  cycle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => {},
  cycle: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_ORDER.find((theme) => theme === stored) ?? 'system';
  } catch {
    return 'system';
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    return;
  }
}
