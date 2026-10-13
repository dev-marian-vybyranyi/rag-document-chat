import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pino } from 'pino';
import { createAiProvider } from '../src/ai/index.js';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { loadGoldenMeetings } from '../src/eval/golden-meetings.js';
import {
  ensureMeetingEvalCorpus,
  MeetingCorpusError,
  removeMeetingEvalUser,
  storedNotes,
} from '../src/eval/meeting-corpus.js';
import {
  createMeetingSearcher,
  evaluateMeetingRetrieval,
  MEETING_THRESHOLDS,
} from '../src/eval/meeting-eval.js';
import { formatMeetingReport, formatNotesReport } from '../src/eval/meeting-report.js';
import { recommendThreshold } from '../src/eval/metrics.js';
import { scoreNotes, summarizeNotes } from '../src/eval/notes-eval.js';
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
  out('Usage: npm run eval:meetings -w @rag-chat/api -- [options]');
  out(
    'Asks the questions in scripts/eval/golden-meetings.json about the meetings in samples/meetings',
  );
  out(
    '  --no-notes     do not ask a model for notes (retrieval only; overview questions lose their notes)',
  );
  out('  --reindex      index the meetings again');
  out('  --cleanup      delete the evaluation user and its meetings afterwards');
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
const reportPath = resolve(option('out') ?? join(repoRoot, 'scripts/eval/results/meetings.json'));

const logger = pino({ level: 'warn' });
const { db, pool } = createDb(env.DATABASE_URL);
const embedder = ai.embedder;

try {
  const golden = loadGoldenMeetings(join(repoRoot, 'scripts/eval/golden-meetings.json'));
  const withNotes = !flag('no-notes');

  out(`Preparing ${golden.meetings.length} meetings (indexed copies are reused)…`);
  const corpus = await ensureMeetingEvalCorpus({
    db,
    embedder,
    embeddingModel: env.EMBEDDING_MODEL,
    logger,
    golden,
    samplesDir: join(repoRoot, 'samples/meetings'),
    reindex: flag('reindex'),
    ...(withNotes && { notes: ai.createNotesExtractor(logger) }),
    onRetry: (what, attempt, error) =>
      out(`  ${what} failed (${error}); waiting a minute before attempt ${attempt + 1}…`),
  });
  out(
    `  indexed: ${corpus.indexed.join(', ') || 'none'}; reused: ${corpus.reused.join(', ') || 'none'}`,
  );
  if (withNotes && corpus.withoutNotes.length > 0) {
    out(`  no notes could be written for: ${corpus.withoutNotes.join(', ')}`);
  }

  const searcher = createMeetingSearcher({
    userId: corpus.userId,
    store: createRetrievalStore(db, { embeddingModel: env.EMBEDDING_MODEL }),
    embedder,
    logger,
    documents: corpus.documents,
    onWait: (ms) => out(`  embedding rate limit reached, waiting ${Math.round(ms / 1000)} s…`),
  });

  const report = await evaluateMeetingRetrieval({
    golden,
    searcher,
    thresholds: MEETING_THRESHOLDS,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) out(`  asked ${done}/${total}`);
    },
  });

  const current = relevanceThresholds(env).meeting;
  out();
  out(formatMeetingReport(report, current));

  const recommendation = recommendThreshold(report.thresholds);
  out();
  if (recommendation) {
    out(
      `Suggested MEETING_RELEVANCE_THRESHOLD: ${recommendation.threshold} (the strictest value that still ` +
        `answers ${(recommendation.answered * 100).toFixed(0)}% of the answerable questions; it refuses ` +
        `${(recommendation.refused * 100).toFixed(0)}% of the unanswerable ones). Currently ${current}.`,
    );
    out('The value depends on the embedding model: measure again when the provider changes.');
  }

  let notesReport: ReturnType<typeof scoreNotes>[] | null = null;
  if (withNotes) {
    const notes = await storedNotes(db, corpus.userId, golden);
    notesReport = golden.notes.map((truth) => scoreNotes(truth, notes.get(truth.meeting) ?? null));
    out();
    out(formatNotesReport(notesReport, summarizeNotes(notesReport)));
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        date: new Date().toISOString(),
        provider: ai.name,
        embeddingModel: env.EMBEDDING_MODEL,
        notesModel: withNotes ? env.REWRITE_MODEL : null,
        meetingRelevanceThreshold: current,
        suggestedThreshold: recommendation,
        ...report,
        notes: notesReport && { summary: summarizeNotes(notesReport), meetings: notesReport },
      },
      null,
      2,
    )}\n`,
  );
  out(`Report written to ${reportPath}`);

  if (flag('cleanup')) {
    await removeMeetingEvalUser(db);
    out('Evaluation user and its meetings deleted.');
  }
} catch (error) {
  if (error instanceof QuotaExhaustedError) {
    out('The daily embedding quota of the free tier is used up. Run again tomorrow.');
    process.exitCode = 1;
  } else if (error instanceof MeetingCorpusError) {
    out(`Could not prepare the meetings: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
