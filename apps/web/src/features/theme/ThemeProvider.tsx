import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  THEME_ORDER,
  ThemeContext,
  readStoredTheme,
  storeTheme,
  type Theme,
  type ThemeContextValue,
} from './theme-context';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(() => matchMedia(DARK_QUERY).matches);

  useEffect(() => {
    const query = matchMedia(DARK_QUERY);
    const update = () => setSystemDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    storeTheme(next);
  }, []);

  const cycle = useCallback(() => {
    setTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!);
  }, [theme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme, cycle }),
    [theme, resolved, setTheme, cycle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
