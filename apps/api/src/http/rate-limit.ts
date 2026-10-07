import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { normalizeEmail } from '../auth/users.js';
import { userOf } from '../auth/middleware.js';
import { AppError } from './errors.js';
import { plural } from './limits.js';

export interface AuthRateLimits {
  maxFailedLogins: number;
  failedLoginWindowMs: number;
  maxRequests: number;
  overallWindowMs: number;
}

export const defaultAuthRateLimits: AuthRateLimits = {
  maxFailedLogins: 10,
  failedLoginWindowMs: 15 * 60 * 1000,
  maxRequests: 100,
  overallWindowMs: 60 * 1000,
};

const tooManyRequests = (_req: Request, _res: unknown, next: (err: AppError) => void) =>
  next(new AppError(429, 'rate_limited', 'Too many attempts. Please try again later.'));

const loginKey = (req: Request): string => {
  const email: unknown = req.body?.email;
  return typeof email === 'string' ? normalizeEmail(email) : 'unknown';
};

export function createAuthRateLimiters(limits: AuthRateLimits) {
  const common = {
    standardHeaders: 'draft-8' as const,
    legacyHeaders: false,
    handler: tooManyRequests,
    validate: { trustProxy: false, xForwardedForHeader: false },
  };

  const overall = rateLimit({
    ...common,
    windowMs: limits.overallWindowMs,
    limit: limits.maxRequests,
    keyGenerator: () => 'auth',
  });

  const failedLogins = rateLimit({
    ...common,
    windowMs: limits.failedLoginWindowMs,
    limit: limits.maxFailedLogins,
    skipSuccessfulRequests: true,
    keyGenerator: loginKey,
  });

  return {
    overall,
    failedLogins,
    forgetFailedLogins: (req: Request) => failedLogins.resetKey(loginKey(req)),
  };
}

export type AuthRateLimiters = ReturnType<typeof createAuthRateLimiters>;

export interface ChatRateLimits {
  perMinute: number;
  perDay: number;
}

export const defaultChatRateLimits: ChatRateLimits = { perMinute: 10, perDay: 150 };

export interface UploadRateLimit {
  perHour: number;
}

export const defaultUploadRateLimit: UploadRateLimit = { perHour: 20 };

export function describeWait(seconds: number): string {
  if (seconds < 60) return plural(Math.max(1, seconds), 'second');
  if (seconds < 3600) return plural(Math.ceil(seconds / 60), 'minute');
  return plural(Math.ceil(seconds / 3600), 'hour');
}

interface UserLimiterOptions {
  windowMs: number;
  limit: number;
  message: (wait: string) => string;
}

export function createUserRateLimiter({ windowMs, limit, message }: UserLimiterOptions) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    keyGenerator: (req) => userOf(req).id,
    handler: (req, _res, next) => {
      const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit
        ?.resetTime;
      const seconds = resetTime ? Math.ceil((resetTime.getTime() - Date.now()) / 1000) : 60;
      next(new AppError(429, 'rate_limited', message(describeWait(seconds))));
    },
  });
}

export function createChatRateLimiters({ perMinute, perDay }: ChatRateLimits) {
  return [
    createUserRateLimiter({
      windowMs: 60 * 1000,
      limit: perMinute,
      message: (wait) => `You are asking too quickly. Try again in ${wait}.`,
    }),
    createUserRateLimiter({
      windowMs: 24 * 60 * 60 * 1000,
      limit: perDay,
      message: (wait) =>
        `You have reached the daily limit of ${plural(perDay, 'question')}. Try again in ${wait}.`,
    }),
  ];
}

export function createUploadRateLimiter({ perHour }: UploadRateLimit) {
  return createUserRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: perHour,
    message: (wait) => `Too many uploads. Try again in ${wait}.`,
  });
}
