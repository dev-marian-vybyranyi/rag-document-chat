import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { describeWait } from '../src/http/rate-limit.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('describeWait', () => {
  it.each([
    [0, '1 second'],
    [1, '1 second'],
    [45, '45 seconds'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [3599, '60 minutes'],
    [3600, '1 hour'],
    [7201, '3 hours'],
  ])('says how long %i seconds is: %s', (seconds, text) => {
    expect(describeWait(seconds)).toBe(text);
  });
});

describe('chat rate limit settings', () => {
  it('default to 10 questions a minute and 150 a day', () => {
    const env = loadEnv(base);

    expect(env.CHAT_RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(env.CHAT_RATE_LIMIT_PER_DAY).toBe(150);
  });

  it('can be set from the environment', () => {
    const env = loadEnv({
      ...base,
      CHAT_RATE_LIMIT_PER_MINUTE: '3',
      CHAT_RATE_LIMIT_PER_DAY: '40',
    });

    expect(env.CHAT_RATE_LIMIT_PER_MINUTE).toBe(3);
    expect(env.CHAT_RATE_LIMIT_PER_DAY).toBe(40);
  });

  it.each(['0', '-1', 'abc', '2.5'])('reject %s', (value) => {
    expect(() => loadEnv({ ...base, CHAT_RATE_LIMIT_PER_MINUTE: value })).toThrow(
      /CHAT_RATE_LIMIT_PER_MINUTE/,
    );
  });
});
