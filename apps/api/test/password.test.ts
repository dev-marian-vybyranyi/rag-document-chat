import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing', () => {
  it('verifies the password it was created from', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a different password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
  });

  it('salts every hash, so equal passwords produce different hashes', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);

    expect(a).not.toBe(b);
  });

  it('never contains the plain password and records its parameters', async () => {
    const hash = await hashPassword('hunter2hunter2');

    expect(hash).not.toContain('hunter2');
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$/);
  });

  it.each(['', 'plain-text', 'scrypt$x$y$z$salt$hash', 'bcrypt$1$2$3$a$b'])(
    'treats the malformed stored hash %j as a failed verification',
    async (stored) => {
      expect(await verifyPassword('anything', stored)).toBe(false);
    },
  );
});
