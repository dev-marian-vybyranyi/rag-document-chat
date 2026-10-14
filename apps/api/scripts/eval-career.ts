import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pino } from 'pino';
import { createAiProvider } from '../src/ai/index.js';
import { createNoopJobProfileExtractor } from '../src/career/job-profile.js';
import { createNoopResumeProfileExtractor } from '../src/career/resume-profile.js';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import {
  CareerCorpusError,
  ensureCareerEvalCorpus,
  removeCareerEvalUsers,
  storedCareer,
  type CareerAnalysers,
  type CareerCorpusName,
} from '../src/eval/career-corpus.js';
import {
  CAREER_THRESHOLDS,
  createCareerSearcher,
  evaluateCareerRetrieval,
  evaluateFits,
} from '../src/eval/career-eval.js';
import { formatCareerReport, formatFitReport } from '../src/eval/career-report.js';
import { loadGoldenCareer } from '../src/eval/golden-career.js';
import { recommendThreshold } from '../src/eval/metrics.js';
import { QuotaExhaustedError } from '../src/eval/quota-exhausted.js';
import { relevanceThresholds } from '../src/rag/relevance.js';
import { createRetrievalStore } from '../src/rag/retrieval.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (flag('help')) {
  out('Usage: npm run eval:career -w @rag-chat/api -- [options]');
  out(
    'Asks the questions in scripts/eval/golden-career.json about the resume and postings in samples/career',
  );
  out('  --no-fit       do not ask a model for profiles and comparisons (retrieval only)');
  out('  --reindex      index the documents again');
  out('  --cleanup      delete the evaluation users and their documents afterwards');
  out('  --out <file>   where to write the JSON report');
  process.exit(0);
}

const env = loadEnv();
const ai = createAiProvider(env);
if (!ai.configured) {
  out(`${ai.keyVariable} is not set: the evaluation needs real embeddings.`);
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const reportPath = resolve(option('out') ?? join(repoRoot, 'scripts/eval/results/career.json'));
const samplesDir = join(repoRoot, 'samples/career');

const logger = pino({ level: 'warn' });
const { db, pool } = createDb(env.DATABASE_URL);
const embedder = ai.embedder;

try {
  const golden = loadGoldenCareer(join(repoRoot, 'scripts/eval/golden-career.json'));
  const withFit = !flag('no-fit');
  const analysers: CareerAnalysers = withFit
    ? {
        resumeProfiles: ai.createResumeProfileExtractor(logger),
        jobProfiles: ai.createJobProfileExtractor(logger),
        matcher: ai.createFitMatcher(logger),
      }
    : {
        resumeProfiles: createNoopResumeProfileExtractor(),
        jobProfiles: createNoopJobProfileExtractor(),
        matcher: { match: async () => null },
      };

  const corpora = {} as Record<
    CareerCorpusName,
    Awaited<ReturnType<typeof ensureCareerEvalCorpus>>
  >;
  for (const name of ['standard', 'injected'] as const) {
    out(`Preparing the ${name} documents (indexed copies are reused)…`);
    corpora[name] = await ensureCareerEvalCorpus({
      db,
      embedder,
      embeddingModel: env.EMBEDDING_MODEL,
      logger,
      golden,
      corpus: name,
      samplesDir,
      analysers,
      reindex: flag('reindex'),
      onRetry: (what, attempt, error) =>
        out(`  ${what} failed (${error}); waiting a minute before attempt ${attempt + 1}…`),
    });
    const result = corpora[name];
    out(
      `  indexed: ${result.indexed.join(', ') || 'none'}; reused: ${result.reused.join(', ') || 'none'}`,
    );
    if (withFit && result.withoutProfile.length > 0) {
      out(`  no profile could be made for: ${result.withoutProfile.join(', ')}`);
    }
    if (withFit && result.withoutFit.length > 0) {
      out(`  no comparison could be made for: ${result.withoutFit.join(', ')}`);
    }
  }

  let fitReport: ReturnType<typeof evaluateFits> | null = null;
  if (withFit) {
    const stored = {
      standard: await storedCareer(db, corpora.standard, golden.corpora.standard.resume),
      injected: await storedCareer(db, corpora.injected, golden.corpora.injected.resume),
    };
    const text = (corpus: CareerCorpusName) =>
      readFileSync(join(samplesDir, golden.corpora[corpus].resume), 'utf8');
    fitReport = evaluateFits({
      golden,
      standard: stored.standard,
      injected: stored.injected,
      resumeText: text('standard'),
      injectedResumeText: text('injected'),
    });
    out();
    out(formatFitReport(fitReport));
  }

  const store = createRetrievalStore(db, { embeddingModel: env.EMBEDDING_MODEL });
  const searcherFor = (name: CareerCorpusName) =>
    createCareerSearcher({
      userId: corpora[name].userId,
      store,
      embedder,
      logger,
      documents: corpora[name].documents,
      onWait: (ms) => out(`  embedding rate limit reached, waiting ${Math.round(ms / 1000)} s…`),
    });

  const report = await evaluateCareerRetrieval({
    golden,
    searchers: { standard: searcherFor('standard'), injected: searcherFor('injected') },
    thresholds: CAREER_THRESHOLDS,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) out(`  asked ${done}/${total}`);
    },
  });

  const current = relevanceThresholds(env).career;
  out();
  out(formatCareerReport(report, current));

  const recommendation = recommendThreshold(report.thresholds);
  out();
  if (recommendation) {
    out(
      `Suggested CAREER_RELEVANCE_THRESHOLD: ${recommendation.threshold} (the strictest value that still ` +
        `answers ${(recommendation.answered * 100).toFixed(0)}% of the answerable questions; it refuses ` +
        `${(recommendation.refused * 100).toFixed(0)}% of the unanswerable ones). Currently ${current}.`,
    );
    out('The value depends on the embedding model: measure again when the provider changes.');
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        date: new Date().toISOString(),
        provider: ai.name,
        embeddingModel: env.EMBEDDING_MODEL,
        analysisModel: withFit ? env.REWRITE_MODEL : null,
        careerRelevanceThreshold: current,
        suggestedThreshold: recommendation,
        fit: fitReport,
        retrieval: report,
      },
      null,
      2,
    )}\n`,
  );
  out(`Report written to ${reportPath}`);

  if (flag('cleanup')) {
    await removeCareerEvalUsers(db);
    out('Evaluation users and their documents deleted.');
  }
} catch (error) {
  if (error instanceof QuotaExhaustedError) {
    out('The daily quota of the free tier is used up. Run again tomorrow.');
    process.exitCode = 1;
  } else if (error instanceof CareerCorpusError) {
    out(`Could not prepare the documents: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
