import { z } from 'zod';

const MODEL_DEFAULTS = {
  google: {
    EMBEDDING_MODEL: 'gemini-embedding-001',
    REWRITE_MODEL: 'gemini-3.5-flash-lite',
    CHAT_MODEL: 'gemini-3.5-flash-lite',
  },
  openai: {
    EMBEDDING_MODEL: 'text-embedding-3-small',
    REWRITE_MODEL: 'gpt-5-nano',
    CHAT_MODEL: 'gpt-5-nano',
  },
} as const;

const optionalSecret = z
  .string()
  .optional()
  .transform((key) => key?.trim() || undefined);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    AI_PROVIDER: z.enum(['google', 'openai']).default('google'),
    GOOGLE_GENERATIVE_AI_API_KEY: optionalSecret,
    OPENAI_API_KEY: optionalSecret,
    EMBEDDING_MODEL: z.string().min(1).optional(),
    EMBEDDING_TOKENS_PER_MINUTE: z.coerce.number().int().positive().default(25000),
    REWRITE_MODEL: z.string().min(1).optional(),
    RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
    CHAT_MODEL: z.string().min(1).optional(),
    CHAT_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    CHAT_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(150),
    EVAL_JUDGE_MODEL: z.string().min(1).optional(),
    EVAL_JUDGE_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
    COOKIE_SECURE: z.stringbool().optional(),
  })
  .transform((env) => ({
    ...env,
    EMBEDDING_MODEL: env.EMBEDDING_MODEL ?? MODEL_DEFAULTS[env.AI_PROVIDER].EMBEDDING_MODEL,
    REWRITE_MODEL: env.REWRITE_MODEL ?? MODEL_DEFAULTS[env.AI_PROVIDER].REWRITE_MODEL,
    CHAT_MODEL: env.CHAT_MODEL ?? MODEL_DEFAULTS[env.AI_PROVIDER].CHAT_MODEL,
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
