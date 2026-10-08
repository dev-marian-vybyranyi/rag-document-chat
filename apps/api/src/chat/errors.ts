import { APICallError, RetryError } from 'ai';
import { isInvalidKeyResponse } from '../ai/api-errors.js';
import { quotaInfoOf } from '../ai/quota.js';
import { EmbeddingError } from '../ai/embeddings.js';
import { describeWait } from '../http/wait.js';

export type ChatFailureKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'overloaded'
  | 'misconfigured'
  | 'timeout'
  | 'cancelled'
  | 'unexpected';

export const CHAT_FAILURE_MESSAGES: Record<ChatFailureKind, string> = {
  rate_limited: 'The AI service is busy (rate limit reached). Please try again in a minute.',
  quota_exhausted: 'The AI quota is used up. Please try again later.',
  overloaded: 'The AI model is overloaded right now. Please try again in a moment.',
  misconfigured: 'The AI service is not configured correctly.',
  timeout: 'The AI model took too long to respond. Please try again.',
  cancelled: 'The request was cancelled.',
  unexpected: 'Something went wrong while generating the answer. Please try again.',
};

export function classifyChatFailure(error: unknown): ChatFailureKind {
  if (error instanceof EmbeddingError) {
    if (error.kind === 'rate_limited') return 'rate_limited';
    if (error.kind === 'quota_exhausted') return 'quota_exhausted';
    if (error.kind === 'misconfigured') return 'misconfigured';
    if (error.kind === 'timeout') return 'timeout';
    if (error.kind === 'cancelled') return 'cancelled';
    return 'unexpected';
  }

  const cause = RetryError.isInstance(error) ? error.lastError : error;

  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === 429) return quotaInfoOf(cause).daily ? 'quota_exhausted' : 'rate_limited';
    if (status === 401 || status === 403) return 'misconfigured';
    if (isInvalidKeyResponse(cause)) return 'misconfigured';
    if (status === 500 || status === 502 || status === 503 || status === 504) return 'overloaded';
    return 'unexpected';
  }
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError') return 'timeout';
    if (cause.name === 'AbortError') return 'cancelled';
  }
  return 'unexpected';
}

export function failureKindOfMessage(message: string): ChatFailureKind | null {
  for (const kind of Object.keys(CHAT_FAILURE_MESSAGES) as ChatFailureKind[]) {
    if (message === CHAT_FAILURE_MESSAGES[kind]) return kind;
  }
  return message.startsWith(RATE_LIMITED_PREFIX) ? 'rate_limited' : null;
}

export function chatFailureMessage(error: unknown): string {
  return CHAT_FAILURE_MESSAGES[classifyChatFailure(error)];
}

export interface ChatFailure {
  kind: ChatFailureKind;
  message: string;
  retryAfterMs: number | null;
}

export function describeChatFailure(error: unknown): ChatFailure {
  const kind = classifyChatFailure(error);
  const retryAfterMs = kind === 'rate_limited' ? quotaInfoOf(error).retryAfterMs : null;
  const message =
    retryAfterMs === null
      ? CHAT_FAILURE_MESSAGES[kind]
      : rateLimitedMessage(Math.ceil(retryAfterMs / 1000));
  return { kind, message, retryAfterMs };
}

const RATE_LIMITED_PREFIX = 'The AI service is busy (rate limit reached).';

export function rateLimitedMessage(seconds: number): string {
  return `${RATE_LIMITED_PREFIX} Please try again in ${describeWait(seconds)}.`;
}
