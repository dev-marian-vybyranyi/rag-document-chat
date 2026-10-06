import { Router } from 'express';
import { AppError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import { hashPassword, verifyPassword } from './password.js';
import { loginSchema, registerSchema } from './schemas.js';
import { EmailTakenError, type User, type UserRepository } from './users.js';

function toPublicUser(user: User) {
  return { id: user.id, email: user.email };
}

export function createAuthRouter(users: UserRepository) {
  const router = Router();

  const decoyHash = hashPassword('decoy-password-for-timing');

  router.post('/register', async (req, res) => {
    const { email, password } = parseBody(registerSchema, req.body);

    try {
      const user = await users.create({ email, passwordHash: await hashPassword(password) });
      res.status(201).json({ user: toPublicUser(user) });
    } catch (error) {
      if (error instanceof EmailTakenError) {
        throw new AppError(409, 'email_taken', 'An account with this email already exists');
      }
      throw error;
    }
  });

  router.post('/login', async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);

    const user = await users.findByEmail(email);
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await decoyHash));
    if (!user || !passwordOk) {
      throw new AppError(401, 'invalid_credentials', 'Incorrect email or password');
    }

    res.json({ user: toPublicUser(user) });
  });

  return router;
}
