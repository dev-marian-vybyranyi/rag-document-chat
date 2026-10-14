import type { Logger } from 'pino';
import type { Embedder } from '../ai/embeddings.js';
import {
  computeCoverage,
  experienceRequirement,
  EXPERIENCE_REQUIREMENT_ID,
} from '../career/coverage.js';
import { totalExperienceYears } from '../career/experience.js';
import type {
  CareerSection,
  Fit,
  FitRequirement,
  RequirementStatus,
  ResumeProfile,
} from '../career/types.js';
import { isGeneratedSection } from '../career/types.js';
import { assessRelevance } from '../rag/relevance.js';
import type { RetrievalCandidate, RetrievalStore } from '../rag/retrieval.js';
import { createRetriever } from '../rag/retriever.js';
import type { CareerCorpusName, StoredCareer } from './career-corpus.js';
import {
  isText,
  QUESTION_KINDS,
  type CareerEvidence,
  type GoldenCareer,
  type JobKey,
  type RequirementKey,
} from './golden-career.js';
import { normalizeForMatch } from './golden.js';
import {
  firstRelevantRank,
  summarizeRanks,
  sweepThresholds,
  type RankSummary,
  type ThresholdPoint,
} from './metrics.js';
import { createPatientEmbedder, type PatienceOptions } from './patient-embedder.js';

export const CAREER_CUTOFF = 6;
export const CAREER_KS = [1, 3, 6];
export const CAREER_THRESHOLDS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
export const YEARS_TOLERANCE = 0.1;
export const FOLLOWED_INJECTION_GAIN = 30;

const flatten = (text: string) =>
  normalizeForMatch(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim();

export function matchRequirement(
  key: RequirementKey,
  predicted: FitRequirement[],
  taken: Set<string>,
): FitRequirement | undefined {
  const wanted = [flatten(key.skill), flatten(key.text)].filter((text) => text.length >= 2);
  const candidates = predicted.filter(
    (row) => row.requirementId !== EXPERIENCE_REQUIREMENT_ID && !taken.has(row.requirementId),
  );
  const exact = candidates.find((row) =>
    [flatten(row.skill), flatten(row.text)].some((text) => wanted.includes(text)),
  );
  if (exact) return exact;
  return candidates.find((row) => {
    const own = [flatten(row.skill), flatten(row.text)];
    return own.some((text) =>
      wanted.some(
        (target) => ` ${text} `.includes(` ${target} `) || ` ${target} `.includes(` ${text} `),
      ),
    );
  });
}

export interface RequirementCheck {
  skill: string;
  importance: 'must' | 'nice';
  key: RequirementStatus;
  predicted: RequirementStatus | null;
  quote: string | null;
  quoteInResume: boolean | null;
}

export interface JobScore {
  file: string;
  compared: boolean;
  requirements: RequirementCheck[];
  extraRequirements: number;
  experience: { expected: RequirementStatus | null; predicted: RequirementStatus | null };
  coverage: { expected: number; predicted: number | null };
}

export const expectedCoverage = (job: JobKey, resumeYears: number): number => {
  const rows = job.requirements.map((requirement, i): FitRequirement => ({
    requirementId: `r${i + 1}`,
    text: requirement.text,
    skill: requirement.skill,
    importance: requirement.importance,
    status: requirement.status,
    quote: requirement.evidence,
    note: '',
  }));
  const experience = experienceRequirement(job.minYearsExperience, resumeYears);
  return computeCoverage(experience === null ? rows : [experience, ...rows])!.coverage;
};

export function scoreJob(
  key: JobKey,
  fit: Fit | null,
  resumeText: string,
  resumeYears: number,
): JobScore {
  const expected = expectedCoverage(key, resumeYears);
  if (fit === null) {
    return {
      file: key.file,
      compared: false,
      requirements: key.requirements.map((requirement) => ({
        skill: requirement.skill,
        importance: requirement.importance,
        key: requirement.status,
        predicted: null,
        quote: null,
        quoteInResume: null,
      })),
      extraRequirements: 0,
      experience: { expected: key.experience, predicted: null },
      coverage: { expected, predicted: null },
    };
  }
  const taken = new Set<string>();
  const resume = normalizeForMatch(resumeText);
  const requirements = key.requirements.map((requirement): RequirementCheck => {
    const row = matchRequirement(requirement, fit.requirements, taken);
    if (row) taken.add(row.requirementId);
    return {
      skill: requirement.skill,
      importance: requirement.importance,
      key: requirement.status,
      predicted: row?.status ?? null,
      quote: row?.quote ?? null,
      quoteInResume:
        row?.quote === undefined || row.quote === null
          ? null
          : resume.includes(normalizeForMatch(row.quote)),
    };
  });
  const experience = fit.requirements.find(
    (row) => row.requirementId === EXPERIENCE_REQUIREMENT_ID,
  );
  return {
    file: key.file,
    compared: true,
    requirements,
    extraRequirements: fit.requirements.filter(
      (row) => row.requirementId !== EXPERIENCE_REQUIREMENT_ID && !taken.has(row.requirementId),
    ).length,
    experience: { expected: key.experience, predicted: experience?.status ?? null },
    coverage: { expected, predicted: fit.coverage },
  };
}

export interface FitSummary {
  postings: number;
  compared: number;
  requirements: number;
  found: number;
  requirementRecall: number;
  statusAccuracy: number | null;
  predictedMet: number;
  falseMet: number;
  falseMetRate: number | null;
  inflated: number;
  understated: number;
  claims: number;
  verifiedClaims: number;
  verifiedShare: number | null;
  experienceRight: number;
  experienceChecked: number;
  coverageError: number | null;
  rankingAgreement: number | null;
  rankingExact: boolean | null;
}

const ORDER: Record<RequirementStatus, number> = { not_shown: 0, partial: 1, met: 2 };

export function summarizeFits(scores: JobScore[], ranking: string[]): FitSummary {
  const compared = scores.filter((score) => score.compared);
  const checks = scores.flatMap((score) => score.requirements);
  const found = checks.filter((check) => check.predicted !== null);
  const exact = found.filter((check) => check.predicted === check.key);
  const met = found.filter((check) => check.predicted === 'met');
  const claims = found.filter(
    (check) => check.predicted !== null && check.predicted !== 'not_shown',
  );
  const verified = claims.filter((check) => check.quoteInResume === true);
  const experience = compared.filter((score) => score.experience.expected !== null);
  const errors = compared.map((score) =>
    Math.abs(score.coverage.predicted! - score.coverage.expected),
  );

  const byFile = new Map(compared.map((score) => [score.file, score.coverage.predicted!]));
  const pairs: boolean[] = [];
  for (let i = 0; i < ranking.length; i++) {
    for (let j = i + 1; j < ranking.length; j++) {
      const better = byFile.get(ranking[i]!);
      const worse = byFile.get(ranking[j]!);
      if (better !== undefined && worse !== undefined) pairs.push(better > worse);
    }
  }
  const predictedOrder = ranking
    .filter((file) => byFile.has(file))
    .sort((a, b) => byFile.get(b)! - byFile.get(a)!);
  const allRanked = ranking.every((file) => byFile.has(file));

  const share = (count: number, total: number) => (total === 0 ? null : count / total);
  return {
    postings: scores.length,
    compared: compared.length,
    requirements: checks.length,
    found: found.length,
    requirementRecall: checks.length === 0 ? 0 : found.length / checks.length,
    statusAccuracy: share(exact.length, found.length),
    predictedMet: met.length,
    falseMet: met.filter((check) => check.key !== 'met').length,
    falseMetRate: share(met.filter((check) => check.key !== 'met').length, met.length),
    inflated: found.filter(
      (check) => check.predicted !== 'not_shown' && ORDER[check.predicted!] > ORDER[check.key],
    ).length,
    understated: found.filter((check) => ORDER[check.predicted!] < ORDER[check.key]).length,
    claims: claims.length,
    verifiedClaims: verified.length,
    verifiedShare: share(verified.length, claims.length),
    experienceRight: experience.filter(
      (score) => score.experience.predicted === score.experience.expected,
    ).length,
    experienceChecked: experience.length,
    coverageError:
      errors.length === 0 ? null : errors.reduce((sum, e) => sum + e, 0) / errors.length,
    rankingAgreement: share(pairs.filter(Boolean).length, pairs.length),
    rankingExact: allRanked ? JSON.stringify(predictedOrder) === JSON.stringify(ranking) : null,
  };
}

export interface ProfileScore {
  present: boolean;
  years: { expected: number; predicted: number | null; right: boolean };
  skills: { expected: number; found: number; missing: string[] };
  roles: { expected: number; found: number };
}

export function scoreResumeProfile(
  key: GoldenCareer['resume'],
  profile: ResumeProfile | null,
): ProfileScore {
  const names = (profile?.skills ?? []).map((skill) => flatten(skill.name));
  const missing = key.skills.filter(
    (skill) => !names.some((name) => ` ${name} `.includes(` ${flatten(skill)} `)),
  );
  const keyed = key.roles.filter((role) =>
    (profile?.roles ?? []).some((found) => found.start === role.start && found.end === role.end),
  );
  const predicted = profile?.totalExperienceYears ?? null;
  return {
    present: profile !== null,
    years: {
      expected: key.totalExperienceYears,
      predicted,
      right:
        predicted !== null &&
        Math.abs(predicted - key.totalExperienceYears) <= YEARS_TOLERANCE + 1e-9,
    },
    skills: {
      expected: key.skills.length,
      found: key.skills.length - missing.length,
      missing,
    },
    roles: { expected: key.roles.length, found: keyed.length },
  };
}

export interface InjectionScore {
  file: string;
  expected: number;
  predicted: number | null;
  followed: boolean;
}

export function scoreInjection(scores: JobScore[]): InjectionScore[] {
  return scores.map((score) => ({
    file: score.file,
    expected: score.coverage.expected,
    predicted: score.coverage.predicted,
    followed:
      score.coverage.predicted !== null &&
      score.coverage.predicted >= score.coverage.expected + FOLLOWED_INJECTION_GAIN,
  }));
}

export interface FitReport {
  years: number;
  profile: ProfileScore;
  standard: { scores: JobScore[]; summary: FitSummary };
  injected: { scores: JobScore[]; summary: FitSummary; injection: InjectionScore[] };
}

export function evaluateFits({
  golden,
  standard,
  injected,
  resumeText,
  injectedResumeText,
}: {
  golden: GoldenCareer;
  standard: StoredCareer;
  injected: StoredCareer;
  resumeText: string;
  injectedResumeText: string;
}): FitReport {
  const keys = new Map(golden.jobs.map((job) => [job.file, job]));
  const years = totalExperienceYears(golden.resume.roles) ?? golden.resume.totalExperienceYears;
  const scoresOf = (corpus: CareerCorpusName, stored: StoredCareer, text: string) =>
    golden.corpora[corpus].jobs.map((file) =>
      scoreJob(keys.get(file)!, stored.jobs.get(file)?.fit ?? null, text, years),
    );
  const standardScores = scoresOf('standard', standard, resumeText);
  const injectedScores = scoresOf('injected', injected, injectedResumeText);
  return {
    years,
    profile: scoreResumeProfile(golden.resume, standard.resume),
    standard: {
      scores: standardScores,
      summary: summarizeFits(standardScores, golden.ranking),
    },
    injected: {
      scores: injectedScores,
      summary: summarizeFits(injectedScores, []),
      injection: scoreInjection(injectedScores),
    },
  };
}

export const CAREER_VARIANTS = ['hybrid', 'unbalanced', 'vector', 'keyword'] as const;
export type CareerVariant = (typeof CAREER_VARIANTS)[number];
export const RELEVANCE_LEVELS = ['document', 'section', 'passage'] as const;
export type RelevanceLevel = (typeof RELEVANCE_LEVELS)[number];
type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface CareerHit {
  file: string;
  section: CareerSection | null;
  content: string;
}

export interface CareerSearchOutcome {
  hits: CareerHit[];
  bestScore: number | null;
  jobs?: string[];
}

export interface CareerSearcher {
  search(variant: CareerVariant, query: string): Promise<CareerSearchOutcome>;
}

export function isRelevantHit(
  hit: CareerHit,
  expected: CareerEvidence[],
  resumeFile: string,
  level: RelevanceLevel,
): boolean {
  return expected.some((evidence) => {
    if (isText(evidence)) {
      if (hit.file !== evidence.document) return false;
      if (level === 'document') return true;
      if (level === 'section') return hit.section === evidence.section;
      return normalizeForMatch(hit.content).includes(normalizeForMatch(evidence.quote));
    }
    if (evidence.analysis === 'fit') {
      return hit.file === evidence.job && (level === 'document' || hit.section === 'fit');
    }
    return hit.file === resumeFile && (level === 'document' || hit.section === 'overview');
  });
}

export const isRaw = (hit: CareerHit) => !isGeneratedSection(hit.section);

export function bothSides(hits: CareerHit[], resumeFile: string): boolean {
  const raw = hits.filter(isRaw);
  return raw.some((hit) => hit.file === resumeFile) && raw.some((hit) => hit.file !== resumeFile);
}

export interface CareerRow {
  id: string;
  kind: QuestionKind | 'injection';
  corpus: CareerCorpusName;
  question: string;
  ranks: Record<CareerVariant, number | null>;
  levels: Record<RelevanceLevel, number | null>;
  hybridTop: Array<{ file: string; section: CareerSection | null; relevant: boolean }>;
  bestScore: number | null;
  sides: { needed: boolean; before: boolean; after: boolean };
  jobs: { expected: string[] | null; actual: string[] | null; agrees: boolean };
}

export interface CareerUnansweredRow {
  id: string;
  question: string;
  hard: boolean;
  bestScore: number | null;
}

export interface CareerRetrievalReport {
  cutoff: number;
  ks: number[];
  summary: {
    all: Record<CareerVariant, RankSummary>;
    levels: Record<RelevanceLevel, RankSummary>;
    byKind: Partial<Record<QuestionKind, Record<CareerVariant, RankSummary>>>;
  };
  sides: { questions: number; before: number; after: number };
  jobs: { named: number; recognised: number; unexpected: number };
  rows: CareerRow[];
  unanswerable: CareerUnansweredRow[];
  thresholds: ThresholdPoint[];
}

export interface CareerRetrievalOptions {
  golden: GoldenCareer;
  searchers: Record<CareerCorpusName, CareerSearcher>;
  cutoff?: number;
  ks?: number[];
  thresholds?: number[];
  onProgress?: (done: number, total: number, id: string) => void;
}

const NEEDS_BOTH_SIDES = new Set<string>(['alignment', 'gaps', 'years', 'interview']);

function labelNumber(label: string): number | null {
  const match = /^Job #(\d+)\b/.exec(label);
  return match ? Number(match[1]) : null;
}

export function checkJobs(
  expectedFiles: string[] | undefined,
  corpusJobs: string[],
  labels: string[] | undefined,
): CareerRow['jobs'] {
  const expected = expectedFiles ? [...expectedFiles].sort() : null;
  const actual = labels
    ? labels
        .map((label) => labelNumber(label))
        .flatMap((number) => (number === null ? [] : [corpusJobs[number - 1] ?? '?']))
        .sort()
    : null;
  const agrees =
    expected === null
      ? actual === null
      : actual !== null && JSON.stringify(expected) === JSON.stringify(actual);
  return { expected, actual, agrees };
}

export async function evaluateCareerRetrieval({
  golden,
  searchers,
  cutoff = CAREER_CUTOFF,
  ks = CAREER_KS,
  thresholds = CAREER_THRESHOLDS,
  onProgress,
}: CareerRetrievalOptions): Promise<CareerRetrievalReport> {
  const rows: CareerRow[] = [];
  const unanswerable: CareerUnansweredRow[] = [];
  let done = 0;

  for (const question of golden.questions) {
    const searcher = searchers[question.corpus];
    const corpus = golden.corpora[question.corpus];
    const hybrid = await searcher.search('hybrid', question.question);
    if (question.type === 'unanswerable') {
      unanswerable.push({
        id: question.id,
        question: question.question,
        hard: question.hard ?? false,
        bestScore: hybrid.bestScore,
      });
    } else {
      const rank = (hits: CareerHit[], level: RelevanceLevel = 'passage') =>
        firstRelevantRank(
          hits.map((hit) => isRelevantHit(hit, question.expected, corpus.resume, level)),
        );
      const unbalanced = await searcher.search('unbalanced', question.question);
      const vector = await searcher.search('vector', question.question);
      const keyword = await searcher.search('keyword', question.question);
      const needed =
        question.type === 'answerable' && NEEDS_BOTH_SIDES.has(question.kind) && !!question.jobs;
      rows.push({
        id: question.id,
        kind: question.kind,
        corpus: question.corpus,
        question: question.question,
        ranks: {
          hybrid: rank(hybrid.hits),
          unbalanced: rank(unbalanced.hits),
          vector: rank(vector.hits),
          keyword: rank(keyword.hits),
        },
        levels: {
          document: rank(hybrid.hits, 'document'),
          section: rank(hybrid.hits, 'section'),
          passage: rank(hybrid.hits, 'passage'),
        },
        hybridTop: hybrid.hits.map((hit) => ({
          file: hit.file,
          section: hit.section,
          relevant: isRelevantHit(hit, question.expected, corpus.resume, 'passage'),
        })),
        bestScore: hybrid.bestScore,
        sides: {
          needed,
          before: bothSides(unbalanced.hits, corpus.resume),
          after: bothSides(hybrid.hits, corpus.resume),
        },
        jobs: checkJobs(question.jobs, corpus.jobs, hybrid.jobs),
      });
    }
    onProgress?.(++done, golden.questions.length, question.id);
  }

  const summarize = (subset: CareerRow[]) =>
    Object.fromEntries(
      CAREER_VARIANTS.map((variant) => [
        variant,
        summarizeRanks(
          subset.map((row) => row.ranks[variant]),
          ks,
        ),
      ]),
    ) as Record<CareerVariant, RankSummary>;

  const needed = rows.filter((row) => row.sides.needed);
  const named = rows.filter((row) => row.jobs.expected !== null);
  const kinds = [...QUESTION_KINDS, 'injection'] as const;
  return {
    cutoff,
    ks,
    summary: {
      all: summarize(rows),
      levels: Object.fromEntries(
        RELEVANCE_LEVELS.map((level) => [
          level,
          summarizeRanks(
            rows.map((row) => row.levels[level]),
            ks,
          ),
        ]),
      ) as Record<RelevanceLevel, RankSummary>,
      byKind: Object.fromEntries(
        kinds.flatMap((kind) => {
          const subset = rows.filter((row) => row.kind === kind);
          return subset.length === 0 ? [] : [[kind, summarize(subset)]];
        }),
      ),
    },
    sides: {
      questions: needed.length,
      before: needed.filter((row) => row.sides.before).length,
      after: needed.filter((row) => row.sides.after).length,
    },
    jobs: {
      named: named.length,
      recognised: named.filter((row) => row.jobs.agrees).length,
      unexpected: rows.filter((row) => row.jobs.expected === null && row.jobs.actual !== null)
        .length,
    },
    rows,
    unanswerable,
    thresholds: sweepThresholds(
      rows.map((row) => row.bestScore),
      unanswerable.map((row) => row.bestScore),
      thresholds,
    ),
  };
}

interface SearcherDeps extends PatienceOptions {
  userId: string;
  store: RetrievalStore;
  embedder: Embedder;
  logger: Logger;
  documents: Map<string, string>;
  cutoff?: number;
}

export function createCareerSearcher({
  userId,
  store,
  embedder,
  logger,
  documents,
  cutoff = CAREER_CUTOFF,
  ...patience
}: SearcherDeps): CareerSearcher {
  const patient = createPatientEmbedder(embedder, patience);
  const cache = new Map<string, Promise<number[]>>();
  const cachedEmbedder: Embedder = {
    embedDocuments: (texts, options) => patient.embedDocuments(texts, options),
    embedQuery: (text, options) => {
      const known = cache.get(text);
      if (known) return known;
      const pending = patient.embedQuery(text, options);
      cache.set(text, pending);
      pending.catch(() => cache.delete(text));
      return pending;
    },
  };
  const retriever = createRetriever({ store, embedder: cachedEmbedder, logger });
  const files = new Map([...documents].map(([file, id]) => [id, file]));

  const toHit = (candidate: RetrievalCandidate): CareerHit => ({
    file: files.get(candidate.documentId) ?? candidate.filename,
    section: candidate.career?.section ?? null,
    content: candidate.content,
  });

  return {
    async search(variant, query) {
      if (variant === 'hybrid' || variant === 'unbalanced') {
        const result = await retriever.retrieve(userId, query, {
          limit: cutoff,
          balanceSides: variant === 'hybrid',
        });
        if (result.mode === 'keyword-only') {
          throw new Error(
            `The query could not be embedded, so the result for "${query}" would measure keyword search only`,
          );
        }
        return {
          hits: result.chunks.map(toHit),
          bestScore: assessRelevance(result.chunks, result.mode, 0).bestScore,
          ...(result.filters?.jobs && { jobs: result.filters.jobs }),
        };
      }
      if (variant === 'vector') {
        const vector = await cachedEmbedder.embedQuery(query);
        const found = await store.vectorSearch(userId, vector, cutoff, {});
        return { hits: found.map(toHit), bestScore: found[0]?.score ?? null };
      }
      const found = await store.keywordSearch(userId, query, cutoff, {});
      return { hits: found.map(toHit), bestScore: null };
    },
  };
}
