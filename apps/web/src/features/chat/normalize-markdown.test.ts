import { describe, expect, it } from 'vitest';
import { normalizeMarkdown } from './normalize-markdown';

describe('normalizeMarkdown', () => {
  it('moves a citation that follows a closing fence onto its own line', () => {
    expect(normalizeMarkdown('```sql\nSELECT 1;\n``` [1]\n\nText')).toBe(
      '```sql\nSELECT 1;\n```\n\n[1]\n\nText',
    );
  });

  it.each(['```[1]', '``` [1][2]', '```  [1, 2]  ', '~~~ [1]', '   ``` [1]'])(
    'handles %j',
    (fence) => {
      expect(normalizeMarkdown(fence)).toMatch(/^ {0,3}(`{3}|~{3})\n\n\[/);
    },
  );

  it('leaves ordinary fences and text alone', () => {
    const text = '```js\nconst a = items[1];\n```\n\nSee [1] and ``` inline ``` too.';

    expect(normalizeMarkdown(text)).toBe(text);
  });

  it('leaves a fence that opens with a language alone', () => {
    expect(normalizeMarkdown('```ts [1]\ncode\n```')).toBe('```ts [1]\ncode\n```');
  });
});
