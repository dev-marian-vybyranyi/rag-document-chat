import { CHAT_FAILURE_MESSAGES } from '../chat/errors.js';

export class QuotaExhaustedError extends Error {
  constructor() {
    super(CHAT_FAILURE_MESSAGES.quota_exhausted);
    this.name = 'QuotaExhaustedError';
  }
}
