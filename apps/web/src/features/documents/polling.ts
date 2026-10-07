export const FAST_POLLS = 15;
export const FAST_DELAY_MS = 2000;
export const SLOW_DELAY_MS = 5000;

export function pollDelay(attempt: number): number {
  return attempt < FAST_POLLS ? FAST_DELAY_MS : SLOW_DELAY_MS;
}
