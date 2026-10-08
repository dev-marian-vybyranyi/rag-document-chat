import { createGoogle } from '@ai-sdk/google';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pino } from 'pino';
import {
  createChatModelFromEnv,
  createEmbedderFromEnv,
  createQueryRewriterFromEnv,
} from '../src/ai/index.js';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { ensureEvalCorpus, removeEvalUser } from '../src/eval/corpus.js';
import { evaluateFaithfulness, summarizeFaithfulness } from '../src/eval/faithfulness-eval.js';
import { formatFaithfulnessReport } from '../src/eval/faithfulness-report.js';
import { loadGoldenSet } from '../src/eval/golden.js';
import { createJudge, createPatientJudge } from '../src/eval/judge.js';
import { createPatientEmbedder } from '../src/eval/patient-embedder.js';
import { QuotaExhaustedError } from '../src/eval/quota-exhausted.js';
import { createResponderAsker } from '../src/eval/responder-asker.js';
import { createRetrievalStore } from '../src/rag/retrieval.js';
import { createRetriever } from '../src/rag/retriever.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (flag('help')) {
  out('Usage: npm run eval:faithfulness -w @rag-chat/api -- [options]');
  out('  --only <id,id>     ask only these golden questions');
  out('  --unanswerable     ask only the questions the documents cannot answer');
  out('  --answerable       ask only the questions the documents can answer');
  out('  --pace-ms <n>      pause between model calls (default 4000)');
  out('  --reindex          delete and index the sample documents again');
  out('  --cleanup          delete the evaluation user and its documents afterwards');
  out('  --out <file>       where to write the JSON report');
  process.exit(0);
}

const env = loadEnv();
if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
  out('GOOGLE_GENERATIVE_AI_API_KEY is not set: the evaluation needs the real models.');
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const reportPath = resolve(
  option('out') ?? join(repoRoot, 'scripts/eval/results/faithfulness.json'),
);
const pacingMs = Number(option('pace-ms') ?? 4000);
const ids = option('only')?.split(',');
const judgeModelId = env.EVAL_JUDGE_MODEL ?? env.CHAT_MODEL;

const logger = pino({ level: 'warn' });
const { db, pool } = createDb(env.DATABASE_URL);
const embedder = createPatientEmbedder(createEmbedderFromEnv(env), {
  onWait: (ms) => out(`  embedding rate limit reached, waiting ${Math.round(ms / 1000)} s…`),
});
const onWait = (ms: number, reason: string) =>
  out(`  model busy (${reason.slice(0, 60)}), waiting ${Math.round(ms / 1000)} s…`);

try {
  const golden = loadGoldenSet(join(repoRoot, 'scripts/eval/golden.json'));

  out('Preparing the sample corpus (documents already indexed are reused)…');
  const corpus = await ensureEvalCorpus({
    db,
    embedder,
    logger,
    samplesDir: join(repoRoot, 'samples'),
    reindex: flag('reindex'),
    onRetry: (filename, attempt, error) =>
      out(`  ${filename} failed (${error}); waiting a minute before attempt ${attempt + 1}…`),
  });
  if (corpus.failed.length > 0) {
    for (const failure of corpus.failed) out(`  FAILED ${failure.filename}: ${failure.error}`);
    throw new Error(
      'The corpus could not be indexed; run again later, indexed documents are kept.',
    );
  }
  out(
    `  indexed: ${corpus.indexed.join(', ') || 'none'}; reused: ${corpus.reused.join(', ') || 'none'}`,
  );

  const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const judge = createPatientJudge(
    createJudge({
      model: google(judgeModelId),
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: env.EVAL_JUDGE_THINKING_LEVEL } },
      },
    }),
    { pacingMs, onWait },
  );
  const asker = createResponderAsker({
    db,
    userId: corpus.userId,
    chat: {
      retriever: createRetriever({ store: createRetrievalStore(db), embedder, logger }),
      rewriter: createQueryRewriterFromEnv(env, logger),
      relevanceThreshold: env.RELEVANCE_THRESHOLD,
      ...createChatModelFromEnv(env),
    },
    logger,
    pacingMs,
    onWait,
  });

  out(`Asking the golden questions (answers by ${env.CHAT_MODEL}, judged by ${judgeModelId})…`);
  const rows = await evaluateFaithfulness({
    golden,
    asker,
    judge,
    only: (question) =>
      (ids ? ids.includes(question.id) : true) &&
      (flag('unanswerable') ? question.type === 'unanswerable' : true) &&
      (flag('answerable') ? question.type === 'answerable' : true),
    onProgress: ({ done, total, id }) => out(`  ${done}/${total} ${id}`),
  });

  const summary = summarizeFaithfulness(rows);
  out();
  out(formatFaithfulnessReport(summary, rows));

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        date: new Date().toISOString(),
        answerModel: env.CHAT_MODEL,
        answerThinkingLevel: env.CHAT_THINKING_LEVEL,
        judgeModel: judgeModelId,
        judgeThinkingLevel: env.EVAL_JUDGE_THINKING_LEVEL,
        relevanceThreshold: env.RELEVANCE_THRESHOLD,
        summary,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  out();
  out(`Report written to ${reportPath}`);

  if (flag('cleanup')) {
    await removeEvalUser(db);
    out('Evaluation user and its documents deleted.');
  }
} catch (error) {
  if (error instanceof QuotaExhaustedError) {
    out('The daily quota of the free tier is used up. Run again tomorrow; nothing is lost.');
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
