import { EMBEDDING_DIMENSIONS } from '../../src/db/schema.js';
import type { Embedder } from '../../src/ai/embeddings.js';

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  }
  return value >>> 0;
}

export function fakeVector(text: string): number[] {
  const seed = hash(text);
  const raw = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed + i * 12.9898));
  const length = Math.hypot(...raw);
  return raw.map((x) => x / length);
}

export interface FakeEmbedder extends Embedder {
  documentCalls: string[][];
  queryCalls: string[];
}

export function createFakeEmbedder(
  hooks: { beforeEmbedDocuments?: (texts: string[]) => Promise<void> | void } = {},
): FakeEmbedder {
  const documentCalls: string[][] = [];
  const queryCalls: string[] = [];
  return {
    documentCalls,
    queryCalls,
    async embedDocuments(texts) {
      documentCalls.push(texts);
      await hooks.beforeEmbedDocuments?.(texts);
      return texts.map(fakeVector);
    },
    async embedQuery(text) {
      queryCalls.push(text);
      return fakeVector(text);
    },
  };
}
