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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('matchMedia', stubMatchMedia());
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
