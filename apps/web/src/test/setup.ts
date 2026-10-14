import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

configure({ asyncUtilTimeout: 3000 });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubMatchMedia(matches = false) {
  return vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
let timerSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  const nativeSetTimeout = globalThis.setTimeout;
  timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const timer = nativeSetTimeout(...args);
    pendingTimers.add(timer);
    return timer;
  }) as typeof setTimeout);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('matchMedia', stubMatchMedia());
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  cleanup();
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  timerSpy?.mockRestore();
  vi.unstubAllGlobals();
});
