import { plural } from './limits.js';

export function describeWait(seconds: number): string {
  if (seconds < 60) return plural(Math.max(1, seconds), 'second');
  if (seconds < 3600) return plural(Math.ceil(seconds / 60), 'minute');
  return plural(Math.ceil(seconds / 3600), 'hour');
}
