import { APICallError, RetryError } from 'ai';

export interface QuotaInfo {
  daily: boolean;
  retryAfterMs: number | null;
}

const RETRY_IN_MESSAGE = /(?:retry|try again) in ([\d.]+(?:ms|[hms])(?:[\d.]+(?:ms|[hms]))*)/i;
const OUT_OF_CREDIT = /insufficient_quota/i;
const DAILY_QUOTA = /PerDay|per day|daily/i;
const MAX_REASONABLE_WAIT_MS = 24 * 60 * 60 * 1000;

function clampWait(ms: number): number | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(Math.ceil(ms), MAX_REASONABLE_WAIT_MS);
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

function parseSeconds(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const plain = /^([\d.]+)\s*s?$/.exec(text);
  if (plain) return clampWait(Number(plain[1]) * 1000);

  const parts = [...text.matchAll(/([\d.]+)(ms|[hms])/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join('') !== text) return null;
  return clampWait(
    parts.reduce(
      (sum, [, amount, unit]) => sum + Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS],
      0,
    ),
  );
}

function parseMilliseconds(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return /^[\d.]+$/.test(text) ? clampWait(Number(text)) : null;
}

function errorBodyOf(body: string | undefined): { code?: unknown; type?: unknown } {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    return parsed.error && typeof parsed.error === 'object' ? parsed.error : {};
  } catch {
    return {};
  }
}

function detailsOf(body: string | undefined): unknown[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { error?: { details?: unknown } };
    return Array.isArray(parsed.error?.details) ? parsed.error.details : [];
  } catch {
    return [];
  }
}

function causeOf(error: unknown): unknown {
  if (RetryError.isInstance(error)) return error.lastError;
  if (error instanceof Error && error.name === 'EmbeddingError' && error.cause) return error.cause;
  return error;
}

export function quotaInfoOf(error: unknown): QuotaInfo {
  const cause = causeOf(error);
  if (!APICallError.isInstance(cause)) return { daily: false, retryAfterMs: null };

  const { code, type } = errorBodyOf(cause.responseBody);
  let daily =
    DAILY_QUOTA.test(cause.message) ||
    OUT_OF_CREDIT.test(`${String(code)} ${String(type)} ${cause.message}`);
  let retryAfterMs: number | null = null;

  for (const detail of detailsOf(cause.responseBody)) {
    const entry = detail as {
      '@type'?: string;
      retryDelay?: unknown;
      violations?: Array<{ quotaId?: string }>;
    };
    if (entry['@type']?.endsWith('RetryInfo')) retryAfterMs ??= parseSeconds(entry.retryDelay);
    for (const violation of entry.violations ?? []) {
      if (violation.quotaId && DAILY_QUOTA.test(violation.quotaId)) daily = true;
    }
  }

  retryAfterMs ??= parseMilliseconds(cause.responseHeaders?.['retry-after-ms']);
  retryAfterMs ??= parseSeconds(cause.responseHeaders?.['retry-after']);
  const inMessage = RETRY_IN_MESSAGE.exec(cause.message)?.[1];
  retryAfterMs ??= parseSeconds(inMessage);

  return { daily, retryAfterMs };
}
