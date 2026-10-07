import { describe, expect, it } from 'vitest';
import { FAST_DELAY_MS, FAST_POLLS, SLOW_DELAY_MS, pollDelay } from './polling';

describe('pollDelay', () => {
  it('checks often at first, because most documents are ready within seconds', () => {
    expect(pollDelay(0)).toBe(FAST_DELAY_MS);
    expect(pollDelay(FAST_POLLS - 1)).toBe(FAST_DELAY_MS);
  });

  it('then eases off, so a stuck document does not keep hammering a free server', () => {
    expect(pollDelay(FAST_POLLS)).toBe(SLOW_DELAY_MS);
    expect(pollDelay(1000)).toBe(SLOW_DELAY_MS);
    expect(SLOW_DELAY_MS).toBeGreaterThan(FAST_DELAY_MS);
  });
});
