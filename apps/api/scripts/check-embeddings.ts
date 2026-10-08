import { createAiProvider } from '../src/ai/index.js';
import { loadEnv } from '../src/config/env.js';
import { EmbeddingError } from '../src/ai/embeddings.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  out('GOOGLE_GENERATIVE_AI_API_KEY is not set.');
  out(
    'Create a key at https://aistudio.google.com/apikey and put it in .env at the repository root.',
  );
  process.exit(1);
}

const modelId = process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001';
const embedder = createAiProvider(
  loadEnv({
    DATABASE_URL: 'postgres://unused',
    GOOGLE_GENERATIVE_AI_API_KEY: apiKey,
    EMBEDDING_MODEL: modelId,
  }),
).embedder;

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
