import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { normalizeEmail } from '../auth/users.js';
import { AppError } from './errors.js';

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
