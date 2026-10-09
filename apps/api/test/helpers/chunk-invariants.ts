import { expect } from 'vitest';
import type { CodeChunk, SourceFile } from '../../src/repositories/chunker.js';

export function expectFaithfulToSource(source: SourceFile, chunks: CodeChunk[]) {
  const lines = source.content.replace(/\r\n/g, '\n').split('\n');
  const covered = new Set<number>();
  for (const chunk of chunks) {
    expect(chunk.startLine).toBeGreaterThanOrEqual(1);
    expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    expect(chunk.endLine).toBeLessThanOrEqual(lines.length);
    const original = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
    if (chunk.content !== original) {
      expect(chunk.startLine).toBe(chunk.endLine);
      expect(original).toContain(chunk.content);
    }
    for (let line = chunk.startLine; line <= chunk.endLine; line++) covered.add(line);
  }
  lines.forEach((text, index) => {
    if (text.trim().length > 0)
      expect(covered.has(index + 1), `line ${index + 1}: ${text}`).toBe(true);
  });
}

export function expectWithinLimit(chunks: CodeChunk[], maxTokens: number) {
  for (const chunk of chunks) {
    expect(chunk.content.length).toBeLessThanOrEqual(maxTokens * 4);
    expect(chunk.content.trim().length).toBeGreaterThan(0);
  }
}

export function expectInReadingOrder(chunks: CodeChunk[]) {
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i]!.startLine).toBeGreaterThanOrEqual(chunks[i - 1]!.startLine);
  }
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
