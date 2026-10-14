import { readFileSync } from 'node:fs';
import { z } from 'zod';

const fileName = z.string().regex(/^[a-z0-9-]+\.txt$/);
const yearMonth = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);

export const SECTIONS = [
  'summary',
  'experience',
  'skills',
  'education',
  'requirements',
  'nice_to_have',
  'responsibilities',
  'other',
] as const;

export const QUESTION_KINDS = [
  'alignment',
  'gaps',
  'years',
  'ranking',
  'resume',
  'job',
  'interview',
  'trap',
] as const;

const requirementKey = z.object({
  skill: z.string().min(1),
  text: z.string().min(1),
  importance: z.enum(['must', 'nice']),
  status: z.enum(['met', 'partial', 'not_shown']),
  evidence: z.string().min(8).nullable(),
  trap: z.string().min(1).optional(),
});

const jobKey = z
  .object({
    file: fileName,
    title: z.string().min(1),
    company: z.string().min(1),
    minYearsExperience: z.number().positive().nullable(),
    experienceQuote: z.string().min(1).nullable(),
    experience: z.enum(['met', 'partial', 'not_shown']).nullable(),
    requirements: z.array(requirementKey).min(1),
  })
  .refine(
    (job) =>
      (job.minYearsExperience === null) === (job.experienceQuote === null) &&
      (job.minYearsExperience === null) === (job.experience === null),
    { message: 'Years, their quote and their status come together' },
  )
  .refine(
    (job) => job.requirements.every((r) => (r.status === 'not_shown') === (r.evidence === null)),
    { message: 'A requirement has evidence in the resume exactly when it is not "not_shown"' },
  );

const textEvidence = z.object({
  kind: z.literal('text'),
  document: fileName,
  section: z.enum(SECTIONS),
  quote: z.string().min(12),
});

const analysisEvidence = z.discriminatedUnion('analysis', [
  z.object({ kind: z.literal('analysis'), analysis: z.literal('fit'), job: fileName }),
  z.object({ kind: z.literal('analysis'), analysis: z.literal('overview') }),
]);

const evidence = z.union([textEvidence, analysisEvidence]);

const base = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  question: z.string().min(5),
  corpus: z.enum(['standard', 'injected']).default('standard'),
  jobs: z.array(fileName).min(1).optional(),
};

const answerable = z.object({
  ...base,
  type: z.literal('answerable'),
  kind: z.enum(QUESTION_KINDS),
  expected: z.array(evidence).min(1),
  answer: z.string().min(1),
});

const unanswerable = z.object({
  ...base,
  type: z.literal('unanswerable'),
  note: z.string().min(1),
  absentTerms: z.array(z.string().min(1)).min(1),
  hard: z.boolean().optional(),
});

const injection = z.object({
  ...base,
  type: z.literal('injection'),
  kind: z.literal('injection'),
  attack: z.object({ document: fileName, quote: z.string().min(12) }),
  expected: z.array(evidence).min(1),
  answer: z.string().min(1),
});

const question = z.discriminatedUnion('type', [answerable, unanswerable, injection]);

const corpus = z.object({ resume: fileName, jobs: z.array(fileName).min(1).max(10) });

const goldenCareerSchema = z
  .object({
    version: z.literal(1),
    description: z.string(),
    corpora: z.object({ standard: corpus, injected: corpus }),
    resume: z.object({
      file: fileName,
      totalExperienceYears: z.number().positive(),
      roles: z
        .array(
          z.object({
            title: z.string().min(1),
            company: z.string().min(1),
            start: yearMonth,
            end: yearMonth.nullable(),
          }),
        )
        .min(1),
      skills: z.array(z.string().min(1)).min(1),
      removed: z.object({
        emails: z.number().int().nonnegative(),
        links: z.number().int().nonnegative(),
        phones: z.number().int().nonnegative(),
        addresses: z.number().int().nonnegative(),
        attributeLines: z.number().int().nonnegative(),
      }),
      kept: z.array(z.string().min(1)),
    }),
    jobs: z.array(jobKey).min(1),
    ranking: z.array(fileName).min(1),
    questions: z.array(question).min(1),
  })
  .refine((set) => new Set(set.questions.map((q) => q.id)).size === set.questions.length, {
    message: 'Question ids must be unique',
  })
  .refine((set) => new Set(set.jobs.map((j) => j.file)).size === set.jobs.length, {
    message: 'Job files must be unique',
  });

export type RequirementKey = z.infer<typeof requirementKey>;
export type JobKey = z.infer<typeof jobKey>;
export type CareerEvidence = z.infer<typeof evidence>;
export type TextEvidence = z.infer<typeof textEvidence>;
export type CareerAnswerable = z.infer<typeof answerable>;
export type CareerUnanswerable = z.infer<typeof unanswerable>;
export type CareerInjection = z.infer<typeof injection>;
export type CareerGoldenQuestion = z.infer<typeof question>;
export type GoldenCareer = z.infer<typeof goldenCareerSchema>;

export const isText = (item: CareerEvidence): item is TextEvidence => item.kind === 'text';

export function parseGoldenCareer(json: unknown): GoldenCareer {
  const result = goldenCareerSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `Invalid golden set for the career assistant:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function loadGoldenCareer(path: string): GoldenCareer {
  return parseGoldenCareer(JSON.parse(readFileSync(path, 'utf8')));
}
