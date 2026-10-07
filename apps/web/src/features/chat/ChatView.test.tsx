import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { answerChunks, jsonResponse, openSse, sseResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };
const chat = {
  id: 'c1',
  title: 'New chat',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:00:00Z',
};
const handbook = {
  id: 1,
  chunkId: 'k1',
  documentId: 'd1',
  filename: 'handbook.pdf',
  page: 4,
  ordinal: 2,
  excerpt: 'HNSW builds a layered graph.',
  score: 0.78,
};

type Routes = Parameters<typeof stubApi>[0];

function setup(messageRoute: Routes[string], extra: Routes = {}) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [chat] }),
    'POST /api/chats/c1/messages': messageRoute,
    ...extra,
  });
  render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

const questionBox = () => screen.findByRole('textbox', { name: 'Your question' });

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(await questionBox(), `${text}{Enter}`);
  return user;
}

const conversation = () => screen.getByRole('list', { name: 'Conversation' });

describe('chat view', () => {
  it('invites the user to ask something in an empty chat', async () => {
    setup(sseResponse(answerChunks(['x'])));

    expect(await screen.findByText(/Ask a question about your documents/)).toBeInTheDocument();
  });

  describe('asking a question', () => {
    it('shows the question, then the streamed answer with its sources', async () => {
      setup(sseResponse(answerChunks(['HNSW is a graph ', 'index [1].'], [handbook])));

      await ask('What is HNSW?');

      const list = conversation();
      expect(within(list).getByText('What is HNSW?')).toBeInTheDocument();
      expect(await within(list).findByText('HNSW is a graph index [1].')).toBeInTheDocument();
      expect(within(list).getByText('handbook.pdf')).toBeInTheDocument();
      expect(within(list).getByText(/p\. 4/)).toBeInTheDocument();
    });

    it('sends only the new question to the server, not the whole conversation', async () => {
      const { calls } = setup(() => sseResponse(answerChunks(['First answer'])));
      const user = await ask('First question');
      await screen.findByText('First answer');

      await user.type(await questionBox(), 'Second question{Enter}');

      await waitFor(() =>
        expect(calls.filter((c) => c.route === 'POST /api/chats/c1/messages')).toHaveLength(2),
      );
      const bodies = calls.filter((c) => c.route.startsWith('POST')).map((c) => c.body);
      expect(bodies).toEqual([{ content: 'First question' }, { content: 'Second question' }]);
    });

    it('clears the box once the question is sent', async () => {
      setup(sseResponse(answerChunks(['ok'])));

      await ask('Hello?');

      expect(await questionBox()).toHaveValue('');
    });

    it('does not show an answer without sources as having any', async () => {
      setup(sseResponse(answerChunks(["I couldn't find this in your documents."])));

      await ask('Who won?');

      await screen.findByText("I couldn't find this in your documents.");
      expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    });

    it('shows what is happening while it waits, then stops showing it', async () => {
      const stream = openSse();
      setup(() => stream.response());
      await ask('What is HNSW?');

      expect(await screen.findByRole('status')).toHaveTextContent('Searching your documents…');

      stream.send({ type: 'start', messageId: 'm' });
      stream.send({ type: 'data-status', data: { stage: 'answering' }, transient: true });
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Writing the answer…'),
      );

      stream.send({ type: 'text-start', id: 't' });
      stream.send({ type: 'text-delta', id: 't', delta: 'Partial' });
      expect(await screen.findByText('Partial')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      stream.send({ type: 'text-end', id: 't' });
      stream.send({ type: 'finish', finishReason: 'stop' });
      stream.end();
    });
  });

  describe('the question box', () => {
    it('cannot send an empty or blank question', async () => {
      const { calls } = setup(sseResponse(answerChunks(['x'])));
      const user = userEvent.setup();
      const box = await questionBox();

      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      await user.type(box, '   {Enter}');

      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      expect(calls.some((c) => c.route.startsWith('POST'))).toBe(false);
    });

    it('starts a new line on Shift+Enter instead of sending', async () => {
      const { calls } = setup(sseResponse(answerChunks(['x'])));
      const user = userEvent.setup();

      await user.type(await questionBox(), 'line one{Shift>}{Enter}{/Shift}line two');

      expect(await questionBox()).toHaveValue('line one\nline two');
      expect(calls.some((c) => c.route.startsWith('POST'))).toBe(false);
    });

    it('sends with the button too, trimmed', async () => {
      const { calls } = setup(sseResponse(answerChunks(['x'])));
      const user = userEvent.setup();

      await user.type(await questionBox(), '  padded question  ');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() =>
        expect(calls.find((c) => c.route.startsWith('POST'))?.body).toEqual({
          content: 'padded question',
        }),
      );
    });

    it('ignores Enter while an answer is still on its way', async () => {
      const stream = openSse();
      const { calls } = setup(() => stream.response());
      const user = await ask('First question');
      await screen.findByRole('button', { name: 'Stop' });

      await user.type(await questionBox(), 'Impatient follow-up{Enter}');

      expect(calls.filter((c) => c.route.startsWith('POST'))).toHaveLength(1);
      expect(await questionBox()).toHaveValue('Impatient follow-up');
      stream.end();
    });

    it('stops accepting new questions while an answer is on its way, and can cancel it', async () => {
      const stream = openSse();
      let signal: AbortSignal | null | undefined;
      setup((request) => {
        signal = request.signal;
        return stream.response();
      });
      const user = await ask('What is HNSW?');

      const stop = await screen.findByRole('button', { name: 'Stop' });
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
      await user.click(stop);

      await waitFor(() => expect(signal?.aborted).toBe(true));
      expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
  });

  describe('when something goes wrong', () => {
    it('shows the reason the server gave inside the stream', async () => {
      setup(
        sseResponse([
          { type: 'start', messageId: 'm' },
          { type: 'error', errorText: 'The AI service is busy. Please try again in a minute.' },
        ]),
      );

      await ask('What is HNSW?');

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The AI service is busy. Please try again in a minute.',
      );
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });

    it('shows the message of a plain HTTP error', async () => {
      setup(
        jsonResponse(503, {
          error: { code: 'chat_unavailable', message: 'The AI service is not configured' },
        }),
      );

      await ask('What is HNSW?');

      expect((await screen.findByRole('alert')).textContent).toBe(
        'The AI service is not configured',
      );
    });

    it('explains a lost connection', async () => {
      setup(() => {
        throw new TypeError('Failed to fetch');
      });

      await ask('What is HNSW?');

      expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
    });

    it('lets the user try again after an error', async () => {
      let attempts = 0;
      setup(() =>
        ++attempts === 1
          ? jsonResponse(503, { error: { code: 'chat_unavailable', message: 'Not now' } })
          : sseResponse(answerChunks(['Now it works'])),
      );
      const user = await ask('First try');
      await screen.findByRole('alert');

      await user.type(await questionBox(), 'Second try{Enter}');

      expect(await screen.findByText('Now it works')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });
  });

  describe('the conversation list', () => {
    it('picks up the title the server gave the chat after the first answer', async () => {
      let listed = 0;
      setup(sseResponse(answerChunks(['An answer'])), {
        'GET /api/chats': () =>
          jsonResponse(200, {
            chats: [++listed === 1 ? chat : { ...chat, title: 'What is HNSW?' }],
          }),
      });
      const nav = await screen.findByRole('navigation', { name: 'Conversations' });
      expect(await within(nav).findByRole('link', { name: 'New chat' })).toBeInTheDocument();

      await ask('What is HNSW?');

      expect(await within(nav).findByRole('link', { name: 'What is HNSW?' })).toBeInTheDocument();
    });
  });
});
