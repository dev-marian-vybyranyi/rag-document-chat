export const TIMESTAMP_SOURCE = String.raw`(?:\d{1,2}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?`;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  if (Number(seconds) >= 60) return null;
  if (hours !== undefined && Number(minutes) >= 60) return null;
  const millis = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0'));
  return (
    Number(hours ?? 0) * MS_PER_HOUR +
    Number(minutes) * MS_PER_MINUTE +
    Number(seconds) * MS_PER_SECOND +
    millis
  );
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
