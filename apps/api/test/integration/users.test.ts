import { describe, expect, it } from 'vitest';
import { createUserRepository, EmailTakenError } from '../../src/auth/users.js';
import { useTestDb } from './helpers.js';

describe('user repository', () => {
  const users = createUserRepository(useTestDb());

  it('creates a user and stores the email normalised', async () => {
    const user = await users.create({ email: '  Ada@Example.COM ', passwordHash: 'hash' });

    expect(user.email).toBe('ada@example.com');
    expect(user.passwordHash).toBe('hash');
  });

  it('refuses a duplicate email regardless of letter case', async () => {
    await users.create({ email: 'ada@example.com', passwordHash: 'hash' });

    const duplicate = users.create({ email: 'ADA@example.com', passwordHash: 'other' });

    await expect(duplicate).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('finds a user by email, ignoring letter case and surrounding spaces', async () => {
    const created = await users.create({ email: 'ada@example.com', passwordHash: 'hash' });

    expect((await users.findByEmail(' Ada@Example.com '))?.id).toBe(created.id);
  });

  it('finds a user by id', async () => {
    const created = await users.create({ email: 'ada@example.com', passwordHash: 'hash' });

    expect((await users.findById(created.id))?.email).toBe('ada@example.com');
  });

  it('returns undefined for unknown users', async () => {
    expect(await users.findByEmail('nobody@example.com')).toBeUndefined();
    expect(await users.findById('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});
