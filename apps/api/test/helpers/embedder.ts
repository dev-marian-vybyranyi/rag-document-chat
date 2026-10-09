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

const FILLER = new Set(
  'a an the is are was were be of in on at to for from by with as and or not it this that what where which who how why when do does did can i you we'.split(
    ' ',
  ),
);

export function wordVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const parts = word
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(' ');
    for (const part of parts) {
      const token = part.toLowerCase();
      if (token.length < 2 || FILLER.has(token)) continue;
      vector[hash(token) % EMBEDDING_DIMENSIONS]! += 1;
    }
  }
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((x) => x / length);
}

export function createWordEmbedder(): FakeEmbedder {
  const documentCalls: string[][] = [];
  const queryCalls: string[] = [];
  return {
    documentCalls,
    queryCalls,
    async embedDocuments(texts) {
      documentCalls.push(texts);
      return texts.map(wordVector);
    },
    async embedQuery(text) {
      queryCalls.push(text);
      return wordVector(text);
    },
  };
}
