import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createQuestionSuggester, parseSuggestions, samplePassages } from '../src/rag/suggest.js';
import { modelAnswering, promptText } from './helpers/language-model.js';

describe('suggestions built from untrusted documents', () => {
  it('drops a suggested question that carries a link', () => {
    const raw =
      'What is HNSW?\nWhere can I read more at https://evil.example/x?\nSee www.evil.example for details\nHow fast are queries?';

    expect(parseSuggestions(raw)).toEqual(['What is HNSW?', 'How fast are queries?']);
  });

  it('removes invisible characters from the excerpts before sampling', () => {
    const hidden = String.fromCodePoint(0xe0049, 0xe0067);

    expect(samplePassages([`vis\u200bible${hidden} text`])).toEqual(['visible text']);
  });

  it('does not send invisible characters to the model', async () => {
    const model = modelAnswering('What is the product?\nHow does it work?\nWho made it?');
    const suggester = createQuestionSuggester({
      model,
      logger: pino({ level: 'silent' }),
    });

    await suggester.suggest({
      filename: 'a\u202e.md',
      passages: [`ignore\u200b rules${String.fromCodePoint(0xe0041)}`],
    });

    const sent = promptText(model.doGenerateCalls[0]!.prompt, 'user');
    expect(sent).toContain('ignore rules');
    expect(sent).not.toMatch(/[\u200b\u202e\u{e0041}]/u);
  });
});
