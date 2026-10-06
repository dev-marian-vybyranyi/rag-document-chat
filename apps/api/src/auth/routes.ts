import { Router, type Response } from 'express';
import { AppError } from '../http/errors.js';
import type { AuthRateLimiters } from '../http/rate-limit.js';
import { parseBody } from '../http/validate.js';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from './cookie.js';
import { requireAuth } from './middleware.js';
import { hashPassword, verifyPassword } from './password.js';
import { loginSchema, registerSchema } from './schemas.js';
import type { SessionRepository } from './sessions.js';
import { EmailTakenError, type User, type UserRepository } from './users.js';

function toPublicUser(user: User) {
  return { id: user.id, email: user.email };
}

interface AuthRouterDeps {
  users: UserRepository;
  sessions: SessionRepository;
  cookieSecure: boolean;
  limiters: AuthRateLimiters;
}

export function createAuthRouter({ users, sessions, cookieSecure, limiters }: AuthRouterDeps) {
  const router = Router();
  router.use(limiters.overall);

  async function startSession(res: Response, userId: string) {
    const { token, expiresAt } = await sessions.create(userId);
    setSessionCookie(res, token, expiresAt, cookieSecure);
  }

  const decoyHash = hashPassword('decoy-password-for-timing');

  router.post('/register', async (req, res) => {
    const { email, password } = parseBody(registerSchema, req.body);

    try {
      const user = await users.create({ email, passwordHash: await hashPassword(password) });
      await startSession(res, user.id);
      res.status(201).json({ user: toPublicUser(user) });
    } catch (error) {
      if (error instanceof EmailTakenError) {
        throw new AppError(409, 'email_taken', 'An account with this email already exists');
      }
      throw error;
    }
  });

  router.post('/login', limiters.failedLogins, async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);

    const user = await users.findByEmail(email);
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await decoyHash));
    if (!user || !passwordOk) {
      throw new AppError(401, 'invalid_credentials', 'Incorrect email or password');
    }

    await limiters.forgetFailedLogins(req);
    await startSession(res, user.id);
    res.json({ user: toPublicUser(user) });
  });

  router.post('/logout', async (req, res) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') await sessions.delete(token);
    clearSessionCookie(res, cookieSecure);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
