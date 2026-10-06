import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sessions, users } from '../../src/db/schema.js';
import { pgErrorCode, useTestDb } from './helpers.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

describe('database schema', () => {
  const db = useTestDb();

  const newUser = (email = 'ada@example.com') => ({ email, passwordHash: 'hash' });
  const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000);

  it('generates an id and creation time for a new user', async () => {
    const [user] = await db.insert(users).values(newUser()).returning();

    expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a second user with the same email', async () => {
    await db.insert(users).values(newUser());

    const duplicate = db.insert(users).values(newUser());

    await expect(duplicate).rejects.toSatisfy((e) => pgErrorCode(e) === UNIQUE_VIOLATION);
  });

  it('rejects a session that points at a missing user', async () => {
    const orphan = db.insert(sessions).values({
      id: 'token-hash',
      userId: '00000000-0000-0000-0000-000000000000',
      expiresAt: inOneHour(),
    });

    await expect(orphan).rejects.toSatisfy((e) => pgErrorCode(e) === FOREIGN_KEY_VIOLATION);
  });

  it('deletes a user’s sessions together with the user', async () => {
    const [user] = await db.insert(users).values(newUser()).returning();
    await db
      .insert(sessions)
      .values({ id: 'token-hash', userId: user!.id, expiresAt: inOneHour() });

    await db.delete(users).where(eq(users.id, user!.id));

    expect(await db.select().from(sessions)).toEqual([]);
  });
});
