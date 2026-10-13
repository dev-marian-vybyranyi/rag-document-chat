import { readFileSync } from 'node:fs';
import { z } from 'zod';

const fileName = z.string().regex(/^[a-z0-9-]+\.(?:txt|vtt)$/);
const keywords = z.array(z.string().min(2)).min(1);

const spokenEvidence = z.object({
  meeting: fileName,
  speaker: z.string().min(1),
  atMs: z.number().int().nonnegative(),
  quote: z.string().min(12),
});

const notesEvidence = z.object({ meeting: fileName, notes: z.literal(true) });

const evidenceSchema = z.union([spokenEvidence, notesEvidence]);

const filtersSchema = z.object({
  speakers: z.array(z.string().min(1)).optional(),
  time: z.string().min(1).optional(),
});

const turnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

const base = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  question: z.string().min(5),
  scope: z.array(fileName).min(1).optional(),
  history: z.array(turnSchema).optional(),
};

export const QUESTION_KINDS = [
  'fact',
  'decision',
  'action',
  'speaker',
  'time',
  'overview',
] as const;

const answerableSchema = z.object({
  ...base,
  type: z.literal('answerable'),
  kind: z.enum(QUESTION_KINDS),
  filters: filtersSchema.optional(),
  expected: z.array(evidenceSchema).min(1),
  answer: z.string().min(1),
});

const unanswerableSchema = z.object({
  ...base,
  type: z.literal('unanswerable'),
  note: z.string().min(1),
  absentTerms: z.array(z.string().min(1)).min(1),
  hard: z.boolean().optional(),
});

const questionSchema = z.discriminatedUnion('type', [answerableSchema, unanswerableSchema]);

const quoted = z.object({ keywords, quote: z.string().min(12) });

const notesTruthSchema = z.object({
  meeting: fileName,
  decisions: z.array(quoted),
  staleDecisions: z.array(quoted),
  notDecisions: z.array(quoted),
  actionItems: z.array(
    z.object({
      owner: z.string().min(1).nullable(),
      keywords,
      due: z.string().min(1).nullable(),
      quote: z.string().min(12),
    }),
  ),
  openQuestions: z.array(quoted),
});

const goldenMeetingsSchema = z
  .object({
    version: z.literal(1),
    description: z.string(),
    meetings: z
      .array(
        z.object({
          file: fileName,
          title: z.string().min(1),
          heldOn: z.iso.date(),
        }),
      )
      .min(1),
    questions: z.array(questionSchema).min(1),
    notes: z.array(notesTruthSchema),
  })
  .refine((set) => new Set(set.questions.map((q) => q.id)).size === set.questions.length, {
    message: 'Question ids must be unique',
  })
  .refine((set) => new Set(set.meetings.map((m) => m.file)).size === set.meetings.length, {
    message: 'Meeting files must be unique',
  });

export type MeetingEvidence = z.infer<typeof evidenceSchema>;
export type SpokenEvidence = z.infer<typeof spokenEvidence>;
export type MeetingAnswerable = z.infer<typeof answerableSchema>;
export type MeetingUnanswerable = z.infer<typeof unanswerableSchema>;
export type MeetingGoldenQuestion = z.infer<typeof questionSchema>;
export type MeetingNotesTruth = z.infer<typeof notesTruthSchema>;
export type GoldenMeetings = z.infer<typeof goldenMeetingsSchema>;

export const isSpoken = (evidence: MeetingEvidence): evidence is SpokenEvidence =>
  'quote' in evidence;

export function parseGoldenMeetings(json: unknown): GoldenMeetings {
  const result = goldenMeetingsSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid golden set for meetings:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadGoldenMeetings(path: string): GoldenMeetings {
  return parseGoldenMeetings(JSON.parse(readFileSync(path, 'utf8')));
}
