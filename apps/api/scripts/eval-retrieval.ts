import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pino } from 'pino';
import { createEmbedderFromEnv, createQueryRewriterFromEnv } from '../src/ai/index.js';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { ensureEvalCorpus, passagesByFile, removeEvalUser } from '../src/eval/corpus.js';
import { loadGoldenSet } from '../src/eval/golden.js';
import { formatRetrievalReport } from '../src/eval/report.js';
import {
  createRetrievalSearcher,
  evaluateRetrieval,
  findUncoveredQuotes,
} from '../src/eval/retrieval-eval.js';
import { createRetrievalStore } from '../src/rag/retrieval.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (flag('help')) {
  out('Usage: npm run eval:retrieval -w @rag-chat/api -- [options]');
  out('  --no-rewrite   search with the question as written, even for follow-ups');
  out('  --reindex      delete and index the sample documents again');
  out('  --cleanup      delete the evaluation user and its documents afterwards');
  out('  --out <file>   where to write the JSON report');
  process.exit(0);
}

const env = loadEnv();
if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
  out('GOOGLE_GENERATIVE_AI_API_KEY is not set: the evaluation needs real embeddings.');
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const samplesDir = join(repoRoot, 'samples');
const reportPath = resolve(option('out') ?? join(repoRoot, 'scripts/eval/results/retrieval.json'));

const logger = pino({ level: 'warn' });
const { db, pool } = createDb(env.DATABASE_URL);
const embedder = createEmbedderFromEnv(env);

try {
  const golden = loadGoldenSet(join(repoRoot, 'scripts/eval/golden.json'));

  out('Preparing the sample corpus (documents already indexed are reused)…');
  const corpus = await ensureEvalCorpus({
    db,
    embedder,
    logger,
    samplesDir,
    reindex: flag('reindex'),
    onRetry: (filename, attempt, error) =>
      out(`  ${filename} failed (${error}); waiting a minute before attempt ${attempt + 1}…`),
  });
  out(`  indexed: ${corpus.indexed.join(', ') || 'none'}`);
  out(`  reused:  ${corpus.reused.join(', ') || 'none'}`);
  if (corpus.failed.length > 0) {
    for (const failure of corpus.failed) out(`  FAILED ${failure.filename}: ${failure.error}`);
    out('Run it again later: the documents that are already indexed are kept and reused.');
    process.exitCode = 1;
  } else {
    const uncovered = findUncoveredQuotes(golden, await passagesByFile(db, corpus.userId));
    if (uncovered.length > 0) {
      out(
        `  ${uncovered.length} expected quotes are not whole inside any passage (cut by a chunk boundary):`,
      );
      for (const item of uncovered) out(`    ${item.id}`);
    }

    const searcher = createRetrievalSearcher({
      userId: corpus.userId,
      store: createRetrievalStore(db),
      embedder,
      rewriter: createQueryRewriterFromEnv(env, logger),
      logger,
      onWait: (ms) => out(`  embedding rate limit reached, waiting ${Math.round(ms / 1000)} s…`),
    });

    const report = await evaluateRetrieval({
      golden,
      searcher,
      rewrite: !flag('no-rewrite'),
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) out(`  asked ${done}/${total}`);
      },
    });

    out();
    out(formatRetrievalReport(report, env.RELEVANCE_THRESHOLD));

    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          date: new Date().toISOString(),
          embeddingModel: env.EMBEDDING_MODEL,
          rewriteModel: env.REWRITE_MODEL,
          relevanceThreshold: env.RELEVANCE_THRESHOLD,
          uncoveredQuotes: uncovered.map((item) => item.id),
          ...report,
        },
        null,
        2,
      )}\n`,
    );
    out();
    out(`Report written to ${reportPath}`);
  }

  if (flag('cleanup') && process.exitCode !== 1) {
    await removeEvalUser(db);
    out('Evaluation user and its documents deleted.');
  }
} finally {
  await pool.end();
}
