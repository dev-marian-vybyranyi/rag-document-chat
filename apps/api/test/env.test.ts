import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadEnv', () => {
  it('applies defaults for everything optional', () => {
    const env = loadEnv(base);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      EMBEDDING_MODEL: 'gemini-embedding-001',
      RELEVANCE_THRESHOLD: 0.65,
      CHAT_MODEL: 'gemini-3.5-flash-lite',
      CHAT_THINKING_LEVEL: 'minimal',
      COOKIE_SECURE: false,
    });
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });

  it('requires a database url and explains what is wrong', () => {
    expect(() => loadEnv({})).toThrow(/Invalid environment configuration[\s\S]*DATABASE_URL/);
    expect(() => loadEnv({ DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
  });

  it('turns the session cookie to HTTPS-only in production unless told otherwise', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(
      false,
    );
  });

  describe('repository import settings', () => {
    it('default to a small repository and no GitHub token', () => {
      const env = loadEnv(base);

      expect(env).toMatchObject({ REPOSITORY_MAX_FILES: 300, REPOSITORY_MAX_CHUNKS: 1500 });
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });

    it('can be changed, and a blank token counts as no token', () => {
      expect(
        loadEnv({
          ...base,
          REPOSITORY_MAX_FILES: '50',
          REPOSITORY_MAX_CHUNKS: '400',
          GITHUB_TOKEN: 'ghp_x',
        }),
      ).toMatchObject({
        REPOSITORY_MAX_FILES: 50,
        REPOSITORY_MAX_CHUNKS: 400,
        GITHUB_TOKEN: 'ghp_x',
      });
      expect(loadEnv({ ...base, GITHUB_TOKEN: '   ' }).GITHUB_TOKEN).toBeUndefined();
    });

    it.each(['0', '-5', 'many'])('reject %s as a limit', (value) => {
      expect(() => loadEnv({ ...base, REPOSITORY_MAX_FILES: value })).toThrow(
        /REPOSITORY_MAX_FILES/,
      );
      expect(() => loadEnv({ ...base, REPOSITORY_MAX_CHUNKS: value })).toThrow(
        /REPOSITORY_MAX_CHUNKS/,
      );
    });
  });

  describe('GOOGLE_GENERATIVE_AI_API_KEY', () => {
    it('is passed through when set', () => {
      expect(loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: 'abc123' })).toMatchObject({
        GOOGLE_GENERATIVE_AI_API_KEY: 'abc123',
      });
    });

    it.each(['', '   '])('counts %j as not set, as left by a blank .env line', (blank) => {
      const env = loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: blank });

      expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    });

    it('is trimmed, since pasted keys often carry a trailing newline', () => {
      const env = loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: ' abc123\n' });

      expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('abc123');
    });
  });

  it('lets the embedding model be switched', () => {
    expect(loadEnv({ ...base, EMBEDDING_MODEL: 'gemini-embedding-2' }).EMBEDDING_MODEL).toBe(
      'gemini-embedding-2',
    );
  });

  it('reads the relevance threshold and keeps it between 0 and 1', () => {
    expect(loadEnv({ ...base, RELEVANCE_THRESHOLD: '0.7' }).RELEVANCE_THRESHOLD).toBe(0.7);
    expect(() => loadEnv({ ...base, RELEVANCE_THRESHOLD: '1.5' })).toThrow(/RELEVANCE_THRESHOLD/);
    expect(() => loadEnv({ ...base, RELEVANCE_THRESHOLD: 'high' })).toThrow(/RELEVANCE_THRESHOLD/);
  });

  it('only accepts a thinking level the model API knows', () => {
    expect(loadEnv({ ...base, CHAT_THINKING_LEVEL: 'low' }).CHAT_THINKING_LEVEL).toBe('low');
    expect(() => loadEnv({ ...base, CHAT_THINKING_LEVEL: 'extreme' })).toThrow(
      /CHAT_THINKING_LEVEL/,
    );
  });
});
