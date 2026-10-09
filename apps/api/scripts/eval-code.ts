import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pino } from 'pino';
import { createAiProvider } from '../src/ai/index.js';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import {
  CodeCorpusError,
  ensureCodeEvalCorpus,
  findPresentAbsentTerms,
  passagesByPath,
  removeCodeEvalUser,
} from '../src/eval/code-corpus.js';
import { loadGoldenSet } from '../src/eval/golden.js';
import { recommendThreshold } from '../src/eval/metrics.js';
import { QuotaExhaustedError } from '../src/eval/quota-exhausted.js';
import { REFERENCE_ADDRESS, REFERENCE_REPOSITORY } from '../src/eval/reference-repository.js';
import { formatRetrievalReport } from '../src/eval/report.js';
import {
  createRetrievalSearcher,
  evaluateRetrieval,
  findUncoveredQuotes,
} from '../src/eval/retrieval-eval.js';
import { relevanceThresholds } from '../src/rag/relevance.js';
import { createRetrievalStore } from '../src/rag/retrieval.js';
import { createGithubImporter } from '../src/repositories/github.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

const CODE_THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (flag('help')) {
  out('Usage: npm run eval:code -w @rag-chat/api -- [options]');
  out(`Asks the questions in scripts/eval/golden-code.json about ${REFERENCE_ADDRESS}`);
  out('  --no-rewrite   search with the question as written, even for follow-ups');
  out('  --reindex      download and index the repository again');
  out('  --cleanup      delete the evaluation user and its repository afterwards');
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
const reportPath = resolve(
  option('out') ?? join(repoRoot, 'scripts/eval/results/code-retrieval.json'),
);

const logger = pino({ level: 'warn' });
const { db, pool } = createDb(env.DATABASE_URL);
const embedder = ai.embedder;

try {
  const golden = loadGoldenSet(join(repoRoot, 'scripts/eval/golden-code.json'));

  out(
    `Preparing ${REFERENCE_REPOSITORY.owner}/${REFERENCE_REPOSITORY.name} at ${REFERENCE_REPOSITORY.commit.slice(0, 7)} (indexed copies are reused)…`,
  );
  const corpus = await ensureCodeEvalCorpus({
    db,
    embedder,
    embeddingModel: env.EMBEDDING_MODEL,
    logger,
    github: createGithubImporter({ token: env.GITHUB_TOKEN }),
    reindex: flag('reindex'),
    onRetry: (attempt, error) =>
      out(`  indexing failed (${error}); waiting a minute before attempt ${attempt + 1}…`),
  });
  out(corpus.reused ? '  reused the copy that is already indexed' : '  downloaded and indexed');

  const passages = await passagesByPath(db, corpus.userId);
  const uncovered = findUncoveredQuotes(golden, passages);
  const present = findPresentAbsentTerms(golden, passages);
  if (uncovered.length > 0 || present.length > 0) {
    out('The question set does not match the repository, so no scores are reported:');
    for (const item of uncovered) {
      out(`  ${item.id}: the quote is not whole inside any passage of ${item.file}`);
    }
    for (const item of present) {
      out(
        `  ${item.id}: "${item.term}" occurs in ${item.path}, so the question is not unanswerable`,
      );
    }
    process.exitCode = 1;
  } else {
    const searcher = createRetrievalSearcher({
      userId: corpus.userId,
      store: createRetrievalStore(db, { embeddingModel: env.EMBEDDING_MODEL }),
      embedder,
      rewriter: ai.createRewriter(logger),
      logger,
      onWait: (ms) => out(`  embedding rate limit reached, waiting ${Math.round(ms / 1000)} s…`),
    });

    const report = await evaluateRetrieval({
      golden,
      searcher,
      rewrite: !flag('no-rewrite'),
      thresholds: CODE_THRESHOLDS,
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) out(`  asked ${done}/${total}`);
      },
    });

    const current = relevanceThresholds(env).code;
    const recommendation = recommendThreshold(report.thresholds);
    out();
    out(formatRetrievalReport(report, current));
    out();
    if (recommendation) {
      out(
        `Suggested CODE_RELEVANCE_THRESHOLD: ${recommendation.threshold} (the strictest value that still ` +
          `answers ${(recommendation.answered * 100).toFixed(0)}% of the answerable questions; it refuses ` +
          `${(recommendation.refused * 100).toFixed(0)}% of the unanswerable ones). Currently ${current}.`,
      );
      if (recommendation.refused < 0.5) {
        out(
          'The cut-off hardly separates these two groups: the unanswerable questions are about the same ' +
            'framework, so their passages score like the answerable ones. Refusing them is left to the model.',
        );
      }
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
          rewriteModel: env.REWRITE_MODEL,
          repository: REFERENCE_REPOSITORY,
          codeRelevanceThreshold: current,
          suggestedThreshold: recommendation,
          ...report,
        },
        null,
        2,
      )}\n`,
    );
    out(`Report written to ${reportPath}`);
  }

  if (flag('cleanup') && process.exitCode !== 1) {
    await removeCodeEvalUser(db);
    out('Evaluation user and its repository deleted.');
  }
} catch (error) {
  if (error instanceof QuotaExhaustedError) {
    out('The daily embedding quota of the free tier is used up. Run again tomorrow.');
    process.exitCode = 1;
  } else if (error instanceof CodeCorpusError) {
    out(`Could not prepare the repository: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
