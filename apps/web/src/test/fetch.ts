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

type Handler = (request: { body: unknown }) => Response | Promise<Response>;

export function stubApi(routes: Record<string, Handler | Response>) {
  const calls: Array<{ route: string; body: unknown }> = [];
  const fetchMock = stubFetch();
  fetchMock.mockImplementation(async (input, init) => {
    const method = init?.method ?? 'GET';
    const route = `${method} ${String(input)}`;
    const handler = routes[route];
    if (!handler) throw new Error(`Unexpected request: ${route}`);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ route, body });
    return typeof handler === 'function' ? handler({ body }) : handler.clone();
  });
  return { fetchMock, calls };
}
