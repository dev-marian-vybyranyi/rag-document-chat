import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { deferredResponse, jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };
const budget = chat('c1', 'Budget 2026');
const handbook = chat('c2', 'Onboarding handbook');

function chat(id: string, title: string) {
  return { id, title, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T11:00:00Z' };
}

const source = {
  id: 1,
  chunkId: 'k1',
  documentId: 'd1',
  filename: 'handbook.pdf',
  page: 4,
  ordinal: 2,
  excerpt: 'HNSW builds a layered graph.',
  score: 0.78,
};

function message(id: string, role: 'user' | 'assistant', content: string, extra = {}) {
  return {
    id,
    role,
    content,
    sources: [],
    retrieval: null,
    createdAt: '2026-10-07T10:00:00Z',
    ...extra,
  };
}

const answered = {
  query: 'What is HNSW?',
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.78,
  outcome: 'answered',
};

function setup(path: string, routes: Parameters<typeof stubApi>[0]) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [budget, handbook] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

describe('opening a saved conversation', () => {
  it('says it is loading, then shows the saved messages in order', async () => {
    const pending = deferredResponse();
    setup('/chats/c1', { 'GET /api/chats/c1': pending.handler });

    expect(await screen.findByText('Loading conversation…')).toBeInTheDocument();
    pending.release(
      jsonResponse(200, {
        chat: budget,
        messages: [
          message('m1', 'user', 'What is **HNSW**?'),
          message('m2', 'assistant', 'A layered graph index [1].', {
            sources: [source],
            retrieval: answered,
          }),
          message('m3', 'user', 'And is it fast?'),
        ],
      }),
    );

    const list = await screen.findByRole('list', { name: 'Conversation' });
    expect(Array.from(list.children).map((li) => li.textContent)).toEqual([
      expect.stringContaining('What is **HNSW**?'),
      expect.stringContaining('A layered graph index [1].'),
      expect.stringContaining('And is it fast?'),
    ]);
    expect(within(list).getByLabelText('Source 1: handbook.pdf, page 4')).toBeInTheDocument();
    expect(within(list).getByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.queryByText('Loading conversation…')).not.toBeInTheDocument();
  });

  it('shows a saved refusal without a sources block', async () => {
    setup('/chats/c1', {
      'GET /api/chats/c1': jsonResponse(200, {
        chat: budget,
        messages: [
          message('m1', 'user', 'Who won?'),
          message('m2', 'assistant', "I couldn't find this in your documents.", {
            retrieval: { ...answered, outcome: 'declined' },
          }),
        ],
      }),
    });

    expect(await screen.findByText(/I couldn't find this/)).toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('continues the conversation after loading it', async () => {
    const { calls } = setup('/chats/c1', {
      'GET /api/chats/c1': jsonResponse(200, {
        chat: budget,
        messages: [
          message('m1', 'user', 'Earlier question'),
          message('m2', 'assistant', 'Earlier answer'),
        ],
      }),
      'POST /api/chats/c1/messages': () =>
        new Response(
          'data: {"type":"start","messageId":"n"}\n\ndata: {"type":"text-start","id":"t"}\n\ndata: {"type":"text-delta","id":"t","delta":"Fresh answer"}\n\ndata: {"type":"text-end","id":"t"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n',
          {
            headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
          },
        ),
    });
    const user = userEvent.setup();

    await user.type(
      await screen.findByRole('textbox', { name: 'Your question' }),
      'New one{Enter}',
    );

    const list = screen.getByRole('list', { name: 'Conversation' });
    await waitFor(() => expect(list).toHaveTextContent('Fresh answer'));
    expect(list).toHaveTextContent('Earlier answer');
    expect(calls.find((c) => c.route.startsWith('POST'))?.body).toEqual({ content: 'New one' });
  });

  it('shows the conversation that was clicked, not the previous one', async () => {
    setup('/chats/c1', {
      'GET /api/chats/c1': jsonResponse(200, {
        chat: budget,
        messages: [message('m1', 'user', 'Budget question')],
      }),
      'GET /api/chats/c2': jsonResponse(200, {
        chat: handbook,
        messages: [message('m2', 'user', 'Handbook question')],
      }),
    });
    const user = userEvent.setup();
    expect(await screen.findByText('Budget question')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Onboarding handbook' }));

    expect(await screen.findByText('Handbook question')).toBeInTheDocument();
    expect(screen.queryByText('Budget question')).not.toBeInTheDocument();
  });

  it('sends the user home when the conversation does not exist', async () => {
    setup('/chats/c9', {
      'GET /api/chats/c9': jsonResponse(404, {
        error: { code: 'not_found', message: 'Chat not found' },
      }),
    });

    expect(
      await screen.findByRole('heading', { name: 'Ask questions about your documents' }),
    ).toBeInTheDocument();
  });

  it('offers another try when loading fails', async () => {
    let attempts = 0;
    setup('/chats/c1', {
      'GET /api/chats/c1': () =>
        ++attempts === 1
          ? new Response('Bad Gateway', { status: 502 })
          : jsonResponse(200, { chat: budget, messages: [message('m1', 'user', 'Back again')] }),
    });
    const user = userEvent.setup();

    expect(await screen.findByText('Could not load this conversation.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Back again')).toBeInTheDocument();
  });
});
