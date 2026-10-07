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

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const finishPart: StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: undefined },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
};

function streamOf(parts: StreamPart[], failure?: Error): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        if (failure) controller.error(failure);
        else controller.close();
      },
    }),
  };
}

function textParts(deltas: string[]): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id: 't1', delta })),
  ];
}

export function modelStreaming(...deltas: string[]) {
  return new MockLanguageModelV4({
    doStream: async () =>
      streamOf([...textParts(deltas), { type: 'text-end', id: 't1' }, finishPart]),
  });
}

export function modelStreamFailing(error: Error) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw error;
    },
  });
}

export function modelStreamBreaking(deltas: string[], error: Error) {
  return new MockLanguageModelV4({
    doStream: async () => streamOf(textParts(deltas), error),
  });
}

export function streamedPromptText(
  model: MockLanguageModelV4,
  role: 'system' | 'user' | 'assistant',
  call = 0,
): string {
  return promptText(model.doStreamCalls[call]!.prompt, role);
}
