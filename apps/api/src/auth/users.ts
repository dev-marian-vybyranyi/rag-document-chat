import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/errors.js';
import { users } from '../db/schema.js';

export type User = typeof users.$inferSelect;

export class EmailTakenError extends Error {
  constructor() {
    super('A user with this email already exists');
    this.name = 'EmailTakenError';
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUserRepository(db: Database) {
  return {
    async create(input: { email: string; passwordHash: string }): Promise<User> {
      try {
        const [user] = await db
          .insert(users)
          .values({ email: normalizeEmail(input.email), passwordHash: input.passwordHash })
          .returning();
        return user!;
      } catch (error) {
        if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new EmailTakenError();
        throw error;
      }
    },

    async findByEmail(email: string): Promise<User | undefined> {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, normalizeEmail(email)))
        .limit(1);
      return user;
    },

    async findById(id: string): Promise<User | undefined> {
      const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return user;
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
