import type request from 'supertest';

export interface SseChunk {
  type: string;
  [key: string]: unknown;
}

export function parseSse(body: string): SseChunk[] {
  return body
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter((data) => data.length > 0 && data !== '[DONE]')
    .map((data) => JSON.parse(data) as SseChunk);
}

export const textOf = (parts: SseChunk[]) =>
  parts
    .filter((p) => p.type === 'text-delta')
    .map((p) => p.delta as string)
    .join('');

export async function askQuestion(
  agent: ReturnType<typeof request.agent>,
  chatId: string,
  content: string,
) {
  const res = await agent
    .post(`/chats/${chatId}/messages`)
    .buffer(true)
    .parse((r, done) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (piece: string) => (data += piece));
      r.on('end', () => done(null, data));
    })
    .send({ content });
  const body = typeof res.body === 'string' ? res.body : '';
  const parts = res.headers['content-type']?.includes('text/event-stream') ? parseSse(body) : [];
  const sourcesPart = parts.find((p) => p.type === 'data-sources');
  const data = sourcesPart?.data as
    | {
        sources: Array<{
          id: number;
          filename: string;
          excerpt: string;
          code?: {
            path: string;
            language: string | null;
            startLine: number | null;
            endLine: number | null;
            symbol: string | null;
          };
        }>;
        retrieval: { outcome: string; threshold: number; bestScore: number | null };
      }
    | undefined;
  return { res, parts, sources: data?.sources ?? [], retrieval: data?.retrieval };
}
