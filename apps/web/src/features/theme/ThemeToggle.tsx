import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme, type Theme } from './theme-context';

const LABEL: Record<Theme, string> = { light: 'light', dark: 'dark', system: 'system' };

export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'light' ? SunIcon : theme === 'dark' ? MoonIcon : MonitorIcon;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[theme]}. Switch theme`}
      title={`Theme: ${LABEL[theme]}`}
    >
      <Icon aria-hidden />
    </Button>
  );
}
