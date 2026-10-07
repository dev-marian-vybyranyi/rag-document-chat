import { MockLanguageModelV4 } from 'ai/test';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

export function generated(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}

export function modelAnswering(text: string) {
  return new MockLanguageModelV4({ doGenerate: async () => generated(text) });
}

export function modelFailing(error: Error) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });
}

type Prompt = MockLanguageModelV4['doGenerateCalls'][number]['prompt'];

export function promptText(prompt: Prompt, role: 'system' | 'user' | 'assistant'): string {
  return prompt
    .filter((message) => message.role === role)
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => ('text' in part ? part.text : '')).join(''),
    )
    .join('\n');
}
