import { APICallError, RetryError } from 'ai';

export interface QuotaInfo {
  daily: boolean;
  retryAfterMs: number | null;
}

const RETRY_IN_MESSAGE = /retry in ([\d.]+)\s*s/i;
const DAILY_QUOTA = /PerDay|per day|daily/i;
const MAX_REASONABLE_WAIT_MS = 24 * 60 * 60 * 1000;

function parseSeconds(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^([\d.]+)\s*s?$/.exec(String(value).trim());
  const seconds = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.ceil(seconds * 1000), MAX_REASONABLE_WAIT_MS);
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

  let daily = DAILY_QUOTA.test(cause.message);
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

  const header = cause.responseHeaders?.['retry-after'];
  retryAfterMs ??= parseSeconds(header);
  const inMessage = RETRY_IN_MESSAGE.exec(cause.message)?.[1];
  retryAfterMs ??= parseSeconds(inMessage);

  return { daily, retryAfterMs };
}
