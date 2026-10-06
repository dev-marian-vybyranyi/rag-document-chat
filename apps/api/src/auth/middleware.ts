import type { RequestHandler } from 'express';
import { AppError } from '../http/errors.js';
import { SESSION_COOKIE } from './cookie.js';
import type { SessionRepository } from './sessions.js';

export interface AuthUser {
  id: string;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function loadSession(sessions: SessionRepository): RequestHandler {
  return async (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      const user = await sessions.findUser(token);
      if (user) req.user = { id: user.id, email: user.email };
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(new AppError(401, 'unauthenticated', 'Sign in to continue'));
    return;
  }
  next();
};
