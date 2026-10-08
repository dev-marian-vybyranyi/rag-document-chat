import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    GOOGLE_GENERATIVE_AI_API_KEY: z
      .string()
      .optional()
      .transform((key) => key?.trim() || undefined),
    EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
    EMBEDDING_TOKENS_PER_MINUTE: z.coerce.number().int().positive().default(25000),
    REWRITE_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
    CHAT_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    CHAT_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    CHAT_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(150),
    COOKIE_SECURE: z.stringbool().optional(),
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  }));

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
