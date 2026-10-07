import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from './ThemeProvider';
import { ThemeToggle } from './ThemeToggle';
import { THEME_STORAGE_KEY, readStoredTheme } from './theme-context';

type Listener = () => void;

function stubSystem(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    })),
  );
  return {
    set(next: boolean) {
      dark = next;
      act(() => listeners.forEach((listener) => listener()));
    },
    listeners,
  };
}

const isDark = () => document.documentElement.classList.contains('dark');

function renderToggle() {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  return screen.getByRole('button', { name: /Switch theme/ });
}

describe('theme', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => document.documentElement.classList.remove('dark'));

  describe('first visit', () => {
    it('follows a light system setting', () => {
      stubSystem(false);

      renderToggle();

      expect(isDark()).toBe(false);
      expect(screen.getByRole('button')).toHaveAccessibleName('Theme: system. Switch theme');
    });

    it('follows a dark system setting', () => {
      stubSystem(true);

      renderToggle();

      expect(isDark()).toBe(true);
    });

    it('follows the system when it changes while the choice is "system"', () => {
      const system = stubSystem(false);
      renderToggle();

      system.set(true);
      expect(isDark()).toBe(true);

      system.set(false);
      expect(isDark()).toBe(false);
    });

    it('stops listening to the system when it goes away', () => {
      const system = stubSystem(false);
      const { unmount } = render(<ThemeProvider>x</ThemeProvider>);

      unmount();

      expect(system.listeners.size).toBe(0);
    });
  });

  describe('choosing', () => {
    it('cycles from the system setting to light, dark, then back, remembering each choice', async () => {
      stubSystem(true);
      const user = userEvent.setup();
      const toggle = renderToggle();
      expect(isDark()).toBe(true);

      await user.click(toggle);
      expect(toggle).toHaveAccessibleName('Theme: light. Switch theme');
      expect(isDark()).toBe(false);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

      await user.click(toggle);
      expect(toggle).toHaveAccessibleName('Theme: dark. Switch theme');
      expect(isDark()).toBe(true);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

      await user.click(toggle);
      expect(toggle).toHaveAccessibleName('Theme: system. Switch theme');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    });

    it('lets an explicit choice override the system', async () => {
      const system = stubSystem(true);
      const user = userEvent.setup();
      const toggle = renderToggle();

      await user.click(toggle);

      expect(toggle).toHaveAccessibleName('Theme: light. Switch theme');
      expect(isDark()).toBe(false);
      system.set(true);
      expect(isDark()).toBe(false);
    });
  });

  describe('a returning visitor', () => {
    it('gets the remembered theme, whatever the system says', () => {
      stubSystem(false);
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');

      renderToggle();

      expect(isDark()).toBe(true);
      expect(screen.getByRole('button')).toHaveAccessibleName('Theme: dark. Switch theme');
    });

    it('ignores a stored value it does not know', () => {
      stubSystem(false);
      localStorage.setItem(THEME_STORAGE_KEY, 'purple');

      renderToggle();

      expect(isDark()).toBe(false);
      expect(screen.getByRole('button')).toHaveAccessibleName('Theme: system. Switch theme');
    });
  });

  describe('when browser storage is unavailable', () => {
    it('still works, it just does not remember', async () => {
      stubSystem(false);
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const user = userEvent.setup();
      const toggle = renderToggle();

      await user.click(toggle);

      expect(toggle).toHaveAccessibleName('Theme: light. Switch theme');
      expect(readStoredTheme()).toBe('system');
      vi.restoreAllMocks();
    });
  });
});
