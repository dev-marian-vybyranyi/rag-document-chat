import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onUnauthorized } from '@/lib/api';
import { jsonResponse, sseResponse, stubFetch } from '../../test/fetch';
import { createChatTransport } from './transport';
import type { ChatUIMessage } from './types';

const message = (id: string, role: 'user' | 'assistant', ...texts: string[]): ChatUIMessage => ({
  id,
  role,
  parts: texts.map((text) => ({ type: 'text' as const, text })),
});

function send(messages: ChatUIMessage[], chatId = 'c1') {
  return createChatTransport(chatId).sendMessages({
    chatId,
    messageId: undefined,
    messages,
    trigger: 'submit-message',
    abortSignal: undefined,
  });
}

describe('the chat transport', () => {
  let fetchMock: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the messages address of the conversation', async () => {
    fetchMock.mockResolvedValue(sseResponse([{ type: 'finish', finishReason: 'stop' }]));

    await send([message('m1', 'user', 'Hello')], 'chat-42');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/chats/chat-42/messages');
    expect(init?.method).toBe('POST');
  });

  it('sends only the newest question, with its text parts joined', async () => {
    fetchMock.mockResolvedValue(sseResponse([{ type: 'finish', finishReason: 'stop' }]));

    await send([
      message('m1', 'user', 'First question'),
      message('m2', 'assistant', 'An answer'),
      message('m3', 'user', 'Second ', 'question'),
    ]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      content: 'Second question',
    });
  });

  it('sends an empty question when there is none, and lets the server refuse it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: 'Request validation failed' } }),
    );

    await expect(send([message('m1', 'assistant', 'Only an answer')])).rejects.toThrow(
      'Request validation failed',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ content: '' });
  });

  describe('when the server answers with an error', () => {
    it('uses the message the server gave', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(503, { error: { code: 'ai_busy', message: 'The AI service is busy.' } }),
      );

      await expect(send([message('m1', 'user', 'Hi')])).rejects.toThrow('The AI service is busy.');
    });

    it('does not show an HTML page or a gateway error as it is', async () => {
      fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

      await expect(send([message('m1', 'user', 'Hi')])).rejects.toThrow(
        'The server returned an unexpected response.',
      );
    });

    it('names the status when the body is JSON without a message', async () => {
      fetchMock.mockResolvedValue(jsonResponse(500, { oops: true }));

      await expect(send([message('m1', 'user', 'Hi')])).rejects.toThrow('Request failed (500)');
    });

    it('tells the app the session ended when the server says the user is not signed in', async () => {
      const ended = vi.fn();
      const stop = onUnauthorized(ended);
      fetchMock.mockResolvedValue(
        jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in to continue' } }),
      );

      await expect(send([message('m1', 'user', 'Hi')])).rejects.toThrow('Sign in to continue');

      expect(ended).toHaveBeenCalledTimes(1);
      stop();
    });

    it('does not report the end of a session for other errors', async () => {
      const ended = vi.fn();
      const stop = onUnauthorized(ended);
      fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'Slow down' } }));

      await expect(send([message('m1', 'user', 'Hi')])).rejects.toThrow('Slow down');

      expect(ended).not.toHaveBeenCalled();
      stop();
    });
  });

  it('explains a lost connection instead of showing the browser’s own message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(send([message('m1', 'user', 'Hi')])).rejects.toThrow(
      'Cannot reach the server. Check your connection.',
    );
  });
});
