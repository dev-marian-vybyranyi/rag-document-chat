import { readFileSync } from 'node:fs';
import { z } from 'zod';

const expectedSchema = z.object({
  file: z.string().min(1),
  page: z.number().int().positive().optional(),
  quote: z.string().min(15),
});

const turnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

const base = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  question: z.string().min(5),
  history: z.array(turnSchema).optional(),
};

const answerableSchema = z.object({
  ...base,
  type: z.literal('answerable'),
  expected: z.array(expectedSchema).min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

const unanswerableSchema = z.object({
  ...base,
  type: z.literal('unanswerable'),
  note: z.string().min(1),
  absentTerms: z.array(z.string().min(1)).min(1),
  hard: z.boolean().optional(),
});

const questionSchema = z.discriminatedUnion('type', [answerableSchema, unanswerableSchema]);

const goldenSetSchema = z
  .object({
    version: z.literal(1),
    description: z.string(),
    questions: z.array(questionSchema).min(1),
  })
  .refine((set) => new Set(set.questions.map((q) => q.id)).size === set.questions.length, {
    message: 'Question ids must be unique',
  });

export type GoldenExpected = z.infer<typeof expectedSchema>;
export type AnswerableQuestion = z.infer<typeof answerableSchema>;
export type UnanswerableQuestion = z.infer<typeof unanswerableSchema>;
export type GoldenQuestion = z.infer<typeof questionSchema>;
export type GoldenSet = z.infer<typeof goldenSetSchema>;

export function parseGoldenSet(json: unknown): GoldenSet {
  const result = goldenSetSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid golden set:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadGoldenSet(path: string): GoldenSet {
  return parseGoldenSet(JSON.parse(readFileSync(path, 'utf8')));
}

export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function containsQuote(text: string, quote: string): boolean {
  return normalizeForMatch(text).includes(normalizeForMatch(quote));
}

export function containsWord(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}
