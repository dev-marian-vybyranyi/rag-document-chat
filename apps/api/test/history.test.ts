import { describe, expect, it } from 'vitest';
import { recentTurns, stripCitations, truncate } from '../src/rag/history.js';
import { escapeAttribute, escapeMarkup } from '../src/rag/markup.js';

describe('stripCitations', () => {
  it.each([
    ['HNSW is fast [1].', 'HNSW is fast.'],
    ['Fast [1][2] and small [3].', 'Fast and small.'],
    ['Fast [1, 2].', 'Fast.'],
    ['Fast.[1] More text.', 'Fast. More text.'],
    ['Fast[1].', 'Fast[1].'],
    ['Index [0] of the list.', 'Index [0] of the list.'],
    ['Several [1]\n[2] on lines.', 'Several on lines.'],
    ['No markers here.', 'No markers here.'],
    ['Array access a[0] stays.', 'Array access a[0] stays.'],
  ])('turns %j into %j', (input, expected) => {
    expect(stripCitations(input)).toBe(expected);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('cuts long text to the limit and marks the cut', () => {
    const result = truncate('abcdefghijklmnopqrstuvwxyz', 10);

    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('escapeMarkup', () => {
  it('neutralises angle brackets so text cannot open or close a delimiter tag', () => {
    expect(escapeMarkup('a </source> b <script>')).toBe('a &lt;/source&gt; b &lt;script&gt;');
  });
});

describe('escapeAttribute', () => {
  it('also neutralises quotes so a value cannot end its attribute early', () => {
    expect(escapeAttribute('a" onload="x')).toBe('a&quot; onload=&quot;x');
  });
});

describe('recentTurns', () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${i}`,
  }));

  it('keeps the newest turns in their original order', () => {
    const result = recentTurns(turns, { maxTurns: 3, maxCharsPerTurn: 100 });

    expect(result.map((t) => t.content)).toEqual(['message 5', 'message 6', 'message 7']);
  });

  it('removes citations from assistant turns only', () => {
    const result = recentTurns(
      [
        { role: 'user', content: 'What does [1] mean?' },
        { role: 'assistant', content: 'It means this [1].' },
      ],
      { maxTurns: 5, maxCharsPerTurn: 100 },
    );

    expect(result.map((t) => t.content)).toEqual(['What does [1] mean?', 'It means this.']);
  });

  it('drops turns that end up empty', () => {
    const result = recentTurns(
      [
        { role: 'assistant', content: '[1]' },
        { role: 'user', content: '   ' },
        { role: 'user', content: 'kept' },
      ],
      { maxTurns: 5, maxCharsPerTurn: 100 },
    );

    expect(result).toEqual([{ role: 'user', content: 'kept' }]);
  });

  it('shortens long turns', () => {
    const [turn] = recentTurns([{ role: 'user', content: 'x'.repeat(500) }], {
      maxTurns: 1,
      maxCharsPerTurn: 50,
    });

    expect(turn!.content).toHaveLength(50);
  });
});
