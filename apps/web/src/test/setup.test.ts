import { describe, expect, it } from 'vitest';

describe('test setup', () => {
  let leftBehindFired = false;

  it('leaves a timer pending when a test ends', () => {
    window.setTimeout(() => {
      leftBehindFired = true;
    }, 30);
  });

  it('does not let that timer fire in a later test', async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(leftBehindFired).toBe(false);
  });
});
