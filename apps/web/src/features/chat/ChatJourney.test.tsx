import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { answerChunks, jsonResponse, openSse, sseResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };
const budget = {
  id: 'c1',
  title: 'Budget 2026',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T11:00:00Z',
};

const source = (id: number, overrides = {}) => ({
  id,
  chunkId: `k${id}`,
  documentId: 'd1',
  filename: 'handbook.pdf',
  page: 4,
  ordinal: 7,
  excerpt: 'HNSW builds a layered graph.',
  score: 0.78,
  ...overrides,
});

const answered = {
  query: 'What is HNSW?',
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.78,
  threshold: 0.65,
  outcome: 'answered',
};

const passages = {
  document: { id: 'd1', filename: 'handbook.pdf', pageCount: 12 },
  target: 7,
  passages: [
    { ordinal: 6, page: 4, content: 'The previous passage.' },
    { ordinal: 7, page: 4, content: 'HNSW builds a layered graph.' },
    { ordinal: 8, page: 5, content: 'The next passage.' },
  ],
};
const PASSAGES = 'GET /api/documents/d1/passages?ordinal=7&radius=2';

const saved = (messages: object[]) => jsonResponse(200, { chat: budget, messages });
const stored = (
  id: string,
  role: string,
  content: string,
  sources: object[],
  retrieval: object | null,
) => ({
  id,
  role,
  content,
  sources,
  retrieval,
  createdAt: 'x',
});

function setup(routes: Parameters<typeof stubApi>[0]) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [budget] }),
    ...routes,
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

describe('the path from a question to its evidence', () => {
  it('goes from the streamed answer to the passage it cites and back again', async () => {
    const streaming = openSse();
    setup({
      'GET /api/chats/c1': saved([]),
      'POST /api/chats/c1/messages': () => streaming.response(),
      [PASSAGES]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();

    await user.type(
      await screen.findByRole('textbox', { name: 'Your question' }),
      'What is HNSW?{Enter}',
    );
    for (const chunk of answerChunks(['HNSW is a ', 'layered graph [1].'], [source(1)], answered)) {
      streaming.send(chunk);
    }
    streaming.end();

    const citation = await screen.findByRole('button', { name: 'Source 1: handbook.pdf, page 4' });
    await user.click(citation);
    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(await within(viewer).findByText('The previous passage.')).toBeInTheDocument();
    expect(within(viewer).getByText(/Cited passage/)).toBeInTheDocument();

    await user.click(within(viewer).getByRole('button', { name: /Close/ }));

    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();
    expect(citation).toHaveFocus();
  });

  it('returns focus to what opened a panel, for the keyboard user who closes it with Escape', async () => {
    setup({
      'GET /api/chats/c1': saved([
        stored('m1', 'user', 'What is HNSW?', [], null),
        stored('m2', 'assistant', 'A layered graph [1].', [source(1)], answered),
      ]),
      [PASSAGES]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();
    const why = await screen.findByRole('button', { name: 'Why this answer?' });

    await user.click(why);
    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(within(panel).getByRole('button', { name: 'Close explanation' })).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('complementary', { name: 'Why this answer' }),
    ).not.toBeInTheDocument();
    expect(why).toHaveFocus();
  });

  it('hands focus from one panel to the next without losing the first button', async () => {
    setup({
      'GET /api/chats/c1': saved([
        stored('m1', 'user', 'What is HNSW?', [], null),
        stored('m2', 'assistant', 'A layered graph [1].', [source(1)], answered),
      ]),
      [PASSAGES]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();
    const citation = await screen.findByRole('button', { name: /Source 1/ });
    const why = screen.getByRole('button', { name: 'Why this answer?' });

    await user.click(citation);
    await screen.findByRole('complementary', { name: 'Source viewer' });
    await user.click(why);
    await screen.findByRole('complementary', { name: 'Why this answer' });
    await user.keyboard('{Escape}');

    expect(why).toHaveFocus();
  });

  it('shows a refusal that fell just short of the threshold as a miss, not as a tie', async () => {
    setup({
      'GET /api/chats/c1': saved([
        stored('m1', 'user', 'What is the price?', [], null),
        stored('m2', 'assistant', "I couldn't find this in your documents.", [], {
          ...answered,
          bestScore: 0.649,
          outcome: 'declined',
          closest: [{ filename: 'handbook.pdf', page: 4, score: 0.649 }],
        }),
      ]),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Why this answer?' }));

    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(
      within(panel).getByText(/Best match 64\.9%, at least 65\.0% is needed/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('img', { name: 'Best similarity 64.9%, required 65.0%' }),
    ).toBeInTheDocument();
  });

  it('keeps whole percents when the numbers are clearly apart', async () => {
    setup({
      'GET /api/chats/c1': saved([
        stored('m1', 'user', 'What is HNSW?', [], null),
        stored('m2', 'assistant', 'A layered graph [1].', [source(1)], answered),
      ]),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Why this answer?' }));

    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(within(panel).getByText(/Best match 78%, at least 65% is needed/)).toBeInTheDocument();
  });

  it('keeps the newest part of the conversation in view while the answer arrives', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const streaming = openSse();
    setup({
      'GET /api/chats/c1': saved([]),
      'POST /api/chats/c1/messages': () => streaming.response(),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your question' }), 'Hi{Enter}');
    await screen.findByText('Hi');
    scrolled.mockClear();

    streaming.send({ type: 'start', messageId: 'm' });
    streaming.send({ type: 'text-start', id: 't' });
    streaming.send({ type: 'text-delta', id: 't', delta: 'Hello ' });
    await screen.findByText(/Hello/);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    const calls = scrolled.mock.calls.length;
    streaming.send({ type: 'text-delta', id: 't', delta: 'there' });
    await screen.findByText(/Hello there/);

    await waitFor(() => expect(scrolled.mock.calls.length).toBeGreaterThan(calls));
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'end' });
    streaming.send({ type: 'text-end', id: 't' });
    streaming.send({ type: 'finish', finishReason: 'stop' });
    streaming.end();
  });

  it('shows a citation that points at a source the answer was not given as plain text', async () => {
    setup({
      'GET /api/chats/c1': saved([
        stored('m1', 'user', 'What is HNSW?', [], null),
        stored('m2', 'assistant', 'A layered graph [1][4].', [source(1)], answered),
      ]),
    });

    await screen.findByRole('button', { name: /Source 1/ });

    expect(screen.queryByRole('button', { name: /Source 4/ })).not.toBeInTheDocument();
    expect(screen.getByText(/A layered graph/)).toHaveTextContent('A layered graph [1][4].');
  });

  it('lets a refusal be explained even though it has no sources to open', async () => {
    setup({
      'GET /api/chats/c1': saved([
        stored('m1', 'user', 'Q?', [], null),
        stored('m2', 'assistant', "I couldn't find this in your documents.", [], {
          ...answered,
          outcome: 'declined',
          bestScore: 0.5,
        }),
      ]),
    });

    expect(await screen.findByRole('button', { name: 'Why this answer?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Source/ })).not.toBeInTheDocument();
  });

  it('streams a refusal the way the server sends it, without sources', async () => {
    setup({
      'GET /api/chats/c1': saved([]),
      'POST /api/chats/c1/messages': () =>
        sseResponse(
          answerChunks(["I couldn't find this in your documents."], [], {
            ...answered,
            outcome: 'declined',
            bestScore: 0.5,
          }),
        ),
    });
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: 'Your question' }), 'Price?{Enter}');

    expect(await screen.findByText("I couldn't find this in your documents.")).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Why this answer?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Source/ })).not.toBeInTheDocument();
  });
});
