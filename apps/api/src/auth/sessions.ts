import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { User } from './users.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionRepository(db: Database) {
  return {
    async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
      await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });

      return { token, expiresAt };
    },

    async findUser(token: string): Promise<User | undefined> {
      const [row] = await db
        .select({ user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
        .limit(1);
      return row?.user;
    },

    async delete(token: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
    },
  };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
