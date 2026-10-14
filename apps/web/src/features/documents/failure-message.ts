import { ApiError } from '../../lib/api';

export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ai_busy') return error.message;
    if (error.isUnavailable) return 'The server is not responding. Try again in a moment.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}
