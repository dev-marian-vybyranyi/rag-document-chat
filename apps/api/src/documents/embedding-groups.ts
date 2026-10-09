import type { Embedder } from '../ai/embeddings.js';

export const EMBEDDING_GROUP_SIZE = 100;

export async function embedInGroups(
  embedder: Embedder,
  texts: string[],
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_GROUP_SIZE) {
    vectors.push(...(await embedder.embedDocuments(texts.slice(i, i + EMBEDDING_GROUP_SIZE))));
    await onProgress?.(vectors.length, texts.length);
  }
  return vectors;
}
