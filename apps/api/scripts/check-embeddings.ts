import { createAiProvider } from '../src/ai/index.js';
import { loadEnv } from '../src/config/env.js';
import { EmbeddingError } from '../src/ai/embeddings.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

const env = loadEnv({ DATABASE_URL: 'postgres://unused', ...process.env });
const ai = createAiProvider(env);
if (!ai.configured) {
  out(`${ai.keyVariable} is not set.`);
  out('Put the key in .env at the repository root (see .env.example).');
  process.exit(1);
}

const modelId = env.EMBEDDING_MODEL;
const embedder = ai.embedder;

const passages = [
  'HNSW is a graph-based index for approximate nearest neighbour search in vector databases.',
  'To bake sourdough bread, feed the starter and let the dough rise overnight.',
  'The Eiffel Tower was completed in 1889 for the World Fair in Paris.',
];
const query = 'How does an approximate vector search index work?';

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((sum, x, i) => sum + x * b[i]!, 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b));
};

try {
  const started = Date.now();
  const vectors = await embedder.embedDocuments(passages);
  const queryVector = await embedder.embedQuery(query);

  out(`model: ${modelId}`);
  out(`vectors: ${vectors.length} x ${vectors[0]?.length} dimensions (${Date.now() - started} ms)`);
  out(`query: ${query}`);
  passages
    .map((text, i) => ({ text, score: cosine(queryVector, vectors[i]!) }))
    .sort((a, b) => b.score - a.score)
    .forEach(({ text, score }) => out(`  ${score.toFixed(3)}  ${text}`));
} catch (error) {
  if (error instanceof EmbeddingError) {
    out(`Failed (${error.kind}): ${error.message}`);
    out(`Cause: ${String(error.cause)}`);
    process.exit(1);
  }
  throw error;
}
