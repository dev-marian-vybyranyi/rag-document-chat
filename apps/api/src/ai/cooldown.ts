export type CooldownReason = 'rate_limited' | 'quota_exhausted';

export interface CooldownState {
  reason: CooldownReason;
  remainingMs: number;
}

export function createCooldown(now: () => number = Date.now) {
  let until = 0;
  let reason: CooldownReason = 'rate_limited';

  return {
    trip(durationMs: number, why: CooldownReason) {
      const end = now() + durationMs;
      if (end <= until) return;
      until = end;
      reason = why;
    },
    state(): CooldownState | null {
      const remainingMs = until - now();
      return remainingMs > 0 ? { reason, remainingMs } : null;
    },
  };
}

export type Cooldown = ReturnType<typeof createCooldown>;
