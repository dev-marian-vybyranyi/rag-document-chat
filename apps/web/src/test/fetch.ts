import { vi } from 'vitest';

export function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

export function stubFetch() {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type Handler = (request: {
  body: unknown;
  signal?: AbortSignal | null;
}) => Response | Promise<Response>;

const DEFAULT_ROUTES: Record<string, Handler | Response> = {
  'GET /api/documents': jsonResponse(200, { documents: [] }),
};

export function stubApi(overrides: Record<string, Handler | Response>) {
  const routes = { ...DEFAULT_ROUTES, ...overrides };
  const calls: Array<{ route: string; body: unknown }> = [];
  const fetchMock = stubFetch();
  fetchMock.mockImplementation(async (input, init) => {
    const method = init?.method ?? 'GET';
    const route = `${method} ${String(input)}`;
    const handler = routes[route];
    if (!handler) throw new Error(`Unexpected request: ${route}`);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ route, body });
    return typeof handler === 'function'
      ? handler({ body, signal: init?.signal })
      : handler.clone();
  });
  return { fetchMock, calls };
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
};

const encoder = new TextEncoder();
const frame = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);

export function sseResponse(chunks: object[]): Response {
  const body = [...chunks.map(frame), encoder.encode('data: [DONE]\n\n')];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of body) controller.enqueue(piece);
        controller.close();
      },
    }),
    { status: 200, headers: SSE_HEADERS },
  );
}

export function openSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: () => new Response(stream, { status: 200, headers: SSE_HEADERS }),
    send: (chunk: object) => controller.enqueue(frame(chunk)),
    end: () => {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  };
}

export function answerChunks(
  text: string[],
  sources: object[] = [],
  retrieval: object = {
    query: 'q',
    rewritten: false,
    mode: 'hybrid',
    bestScore: 0.8,
    outcome: 'answered',
  },
): object[] {
  return [
    { type: 'start', messageId: 'm-answer' },
    { type: 'data-status', data: { stage: 'searching' }, transient: true },
    { type: 'data-sources', data: { sources, retrieval } },
    { type: 'data-status', data: { stage: 'answering' }, transient: true },
    { type: 'text-start', id: 't' },
    ...text.map((delta) => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop' },
  ];
}
