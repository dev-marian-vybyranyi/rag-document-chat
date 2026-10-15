import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    'GET /api/chats/c1': jsonResponse(200, { chat, messages: [] }),
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

function geometry(element: HTMLElement, scrollTop: number) {
  Object.defineProperty(element, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: 500, configurable: true });
  Object.defineProperty(element, 'scrollTop', { value: scrollTop, configurable: true });
  fireEvent.scroll(element);
}

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
      await waitFor(() => expect(list).toHaveTextContent('HNSW is a graph index [1].'));
      expect(within(list).getByText('handbook.pdf')).toBeInTheDocument();
      expect(within(list).getByText(/p\. 4/)).toBeInTheDocument();
    });

    it('formats the answer as Markdown but shows the question as typed', async () => {
      setup(sseResponse(answerChunks(['Use **bold** and `code` [1].'], [handbook])));

      await ask('What does **this** do?');

      const list = conversation();
      expect(within(list).getByText('What does **this** do?')).toBeInTheDocument();
      expect((await within(list).findByText('bold')).tagName).toBe('STRONG');
      expect(within(list).getByLabelText('Source 1: handbook.pdf, page 4')).toBeInTheDocument();
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

  describe('keeping the reader in place', () => {
    const scrollIntoView = vi.fn();

    afterEach(() => {
      scrollIntoView.mockClear();
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    });

    function stubScrolling() {
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        value: scrollIntoView,
        configurable: true,
        writable: true,
      });
    }

    async function startStreaming() {
      stubScrolling();
      const stream = openSse();
      setup(() => stream.response());
      await ask('What is HNSW?');
      stream.send({ type: 'start', messageId: 'm' });
      stream.send({ type: 'text-start', id: 't' });
      stream.send({ type: 'text-delta', id: 't', delta: 'One ' });
      await screen.findByText(/One/);
      return { stream, scroller: conversation().parentElement! };
    }

    it('follows a streaming answer while the reader is at the bottom', async () => {
      const { stream, scroller } = await startStreaming();
      geometry(scroller, 1480);
      scrollIntoView.mockClear();

      stream.send({ type: 'text-delta', id: 't', delta: 'two' });

      await screen.findByText(/One two/);
      expect(scrollIntoView).toHaveBeenCalled();
    });

    it('stops following once the reader scrolls up to read, and resumes at the bottom', async () => {
      const { stream, scroller } = await startStreaming();
      geometry(scroller, 0);
      scrollIntoView.mockClear();

      stream.send({ type: 'text-delta', id: 't', delta: 'two' });
      await screen.findByText(/One two/);
      expect(scrollIntoView).not.toHaveBeenCalled();

      geometry(scroller, 1450);
      stream.send({ type: 'text-delta', id: 't', delta: ' three' });
      await screen.findByText(/One two three/);
      expect(scrollIntoView).toHaveBeenCalled();
    });

    it('scrolls to a new question even when the reader had scrolled up', async () => {
      const { stream, scroller } = await startStreaming();
      stream.send({ type: 'text-end', id: 't' });
      stream.send({ type: 'finish', finishReason: 'stop' });
      stream.end();
      await screen.findByText('The answer is ready.');
      geometry(scroller, 0);
      scrollIntoView.mockClear();

      const user = userEvent.setup();
      await user.type(await questionBox(), 'Another question{Enter}');

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    });
  });

  describe('telling a screen reader the answer is done', () => {
    const announcer = () => document.querySelector('[aria-live="polite"]')!;

    it('stays silent while the answer streams and says when it is ready', async () => {
      const stream = openSse();
      setup(() => stream.response());
      await ask('What is HNSW?');
      stream.send({ type: 'start', messageId: 'm' });
      stream.send({ type: 'text-start', id: 't' });
      stream.send({ type: 'text-delta', id: 't', delta: 'Partial' });
      await screen.findByText('Partial');
      expect(announcer()).toBeEmptyDOMElement();

      stream.send({ type: 'text-end', id: 't' });
      stream.send({ type: 'finish', finishReason: 'stop' });
      stream.end();

      await waitFor(() => expect(announcer()).toHaveTextContent('The answer is ready.'));
    });

    it('says when the answer was stopped', async () => {
      const stream = openSse();
      setup(() => stream.response());
      const user = await ask('What is HNSW?');
      stream.send({ type: 'start', messageId: 'm' });
      stream.send({ type: 'text-start', id: 't' });
      stream.send({ type: 'text-delta', id: 't', delta: 'Partial' });
      await screen.findByText('Partial');

      await user.click(screen.getByRole('button', { name: 'Stop' }));

      await waitFor(() => expect(announcer()).toHaveTextContent('The answer was stopped.'));
    });

    it('clears the message when the next question is sent, so it can be said again', async () => {
      const second = openSse();
      let asked = 0;
      setup(() => (++asked === 1 ? sseResponse(answerChunks(['First'])) : second.response()));
      const user = await ask('One');
      await waitFor(() => expect(announcer()).toHaveTextContent('The answer is ready.'));

      await user.type(await questionBox(), 'Two{Enter}');

      await waitFor(() => expect(announcer()).toBeEmptyDOMElement());
      second.send({ type: 'start', messageId: 'm2' });
      second.send({ type: 'text-start', id: 't' });
      second.send({ type: 'text-delta', id: 't', delta: 'Second' });
      second.send({ type: 'text-end', id: 't' });
      second.send({ type: 'finish', finishReason: 'stop' });
      second.end();
      await waitFor(() => expect(announcer()).toHaveTextContent('The answer is ready.'));
    });

    it('does not say the answer is ready when the request failed', async () => {
      setup(jsonResponse(500, { error: { code: 'internal_error', message: 'boom' } }));
      await ask('What is HNSW?');

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(announcer()).toBeEmptyDOMElement();
    });
  });

  describe('when the answer fails', () => {
    it('offers to try again, and asks the same question once more without showing it twice', async () => {
      let asked = 0;
      const { calls } = setup(() =>
        ++asked === 1
          ? jsonResponse(500, { error: { code: 'internal_error', message: 'The model is down.' } })
          : sseResponse(answerChunks(['Now it works'])),
      );
      const user = await ask('What is HNSW?');
      expect(await screen.findByRole('alert')).toHaveTextContent('The model is down.');

      await user.click(screen.getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(conversation()).toHaveTextContent('Now it works'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(within(conversation()).getAllByText('What is HNSW?')).toHaveLength(1);
      const bodies = calls.filter((c) => c.route.startsWith('POST')).map((c) => c.body);
      expect(bodies).toEqual([{ content: 'What is HNSW?' }, { content: 'What is HNSW?' }]);
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

      expect(
        within(await screen.findByRole('alert')).getByText('The AI service is not configured'),
      ).toBeInTheDocument();
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
