import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { PassagesResponse } from '../documents/api';

const ada = { id: 'u1', email: 'ada@example.com' };
const chat = {
  id: 'c1',
  title: 'Release',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T11:00:00Z',
};

const speakers = ['Alice', 'Bob', 'Carol'];

function transcriptSource(overrides = {}) {
  return {
    id: 1,
    chunkId: 'k1',
    documentId: 'm1',
    filename: 'Release sync',
    page: null,
    meeting: { startMs: 70_000, endMs: 120_000, speakers },
    ordinal: 1,
    excerpt: '[00:01:10] Carol: I will update the changelog today.',
    score: 0.58,
    ...overrides,
  };
}

function notesSource(overrides = {}) {
  return transcriptSource({
    id: 2,
    chunkId: 'k2',
    ordinal: 2,
    meeting: { startMs: null, endMs: null, speakers },
    excerpt: 'Meeting notes: Release sync (2026-10-01)',
    score: 0.51,
    ...overrides,
  });
}

const answered = {
  query: 'Who updates the changelog?',
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.58,
  outcome: 'answered',
};

function savedChat(sources: object[], content = 'Carol updates it [1]. See also [2].') {
  return {
    chat,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'Who updates the changelog?',
        sources: [],
        retrieval: null,
        createdAt: 'x',
      },
      { id: 'm2', role: 'assistant', content, sources, retrieval: answered, createdAt: 'x' },
    ],
  };
}

const header = 'Meeting: Release sync (2026-10-01)';

const meetingDocument: PassagesResponse['document'] = {
  id: 'm1',
  filename: 'Release sync',
  pageCount: null,
  kind: 'transcript',
  repoUrl: null,
  commitSha: null,
};

const around = (): PassagesResponse => ({
  document: meetingDocument,
  target: 1,
  passages: [
    {
      ordinal: 0,
      page: null,
      meeting: { startMs: 5000, endMs: 70_000, speakers: ['Alice', 'Bob'] },
      content: `${header}\n[00:00:05] Alice: Morning everyone.\n[00:00:30] Bob: The build is green.`,
    },
    {
      ordinal: 1,
      page: null,
      meeting: { startMs: 30_000, endMs: 120_000, speakers },
      content: `${header}\n[00:00:30] Bob: The build is green.\n[00:01:10] Carol: I will update the changelog today.\n[00:01:40] Alice: Thanks, <b>please</b> do.`,
    },
    {
      ordinal: 2,
      page: null,
      meeting: { startMs: null, endMs: null, speakers },
      content: 'Meeting notes: Release sync (2026-10-01)\nSummary: They planned the release.',
    },
  ],
});

type Routes = Parameters<typeof stubApi>[0];

function setup(routes: Routes) {
  stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [chat] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const viewer = () => screen.findByRole('complementary', { name: 'Source viewer' });

async function openViewer(
  passages: Response | (() => Response),
  sources: object[] = [transcriptSource(), notesSource()],
  which = 1,
  ordinal = 1,
) {
  setup({
    'GET /api/chats/c1': jsonResponse(200, savedChat(sources)),
    [`GET /api/documents/m1/passages?ordinal=${ordinal}&radius=2`]: passages,
  });
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText(new RegExp(`Source ${which}`)));
  return { user, panel: await viewer() };
}

describe('a source that is part of a meeting', () => {
  describe('in the answer', () => {
    it('is named by the meeting, the time and who speaks, on the citation and in the list', async () => {
      setup({
        'GET /api/chats/c1': jsonResponse(200, savedChat([transcriptSource(), notesSource()])),
      });

      expect(
        await screen.findByLabelText('Source 1: Release sync · 00:01:10 · Alice, Bob +1'),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Source 2: Release sync · notes')).toBeInTheDocument();
      const buttons = screen.getAllByRole('button', { name: /Release sync · 00:01:10/ });
      expect(buttons.map((b) => b.textContent)).toContain(
        '[1] Release sync · 00:01:10 · Alice, Bob +1',
      );
    });

    it('says which part of the meeting it is when the citation is hovered', async () => {
      setup({
        'GET /api/chats/c1': jsonResponse(200, savedChat([transcriptSource(), notesSource()])),
      });
      const user = userEvent.setup();

      await user.hover(await screen.findByLabelText(/Source 1/));

      expect(
        await screen.findByText('Transcript 00:01:10–00:02:00 · Alice, Bob +1 · Similarity 58%'),
      ).toBeInTheDocument();
    });

    it('says it is the notes when the notes are cited', async () => {
      setup({
        'GET /api/chats/c1': jsonResponse(200, savedChat([transcriptSource(), notesSource()])),
      });
      const user = userEvent.setup();

      await user.hover(await screen.findByLabelText(/Source 2/));

      expect(
        await screen.findByText('Meeting notes · Alice, Bob +1 · Similarity 51%'),
      ).toBeInTheDocument();
    });
  });

  describe('the viewer of the transcript', () => {
    it('is titled with the meeting and says which part and which source it is', async () => {
      const { panel } = await openViewer(jsonResponse(200, around()));

      expect(within(panel).getByRole('heading', { name: 'Release sync' })).toBeInTheDocument();
      expect(panel).toHaveTextContent('Source [1] · Transcript 00:01:10–00:02:00 · Similarity 58%');
    });

    it('shows each turn with its time and speaker, once, in order', async () => {
      const { panel } = await openViewer(jsonResponse(200, around()));

      const list = await within(panel).findByRole('list', { name: 'Transcript' });

      expect(
        within(list)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([
        '00:00:05Alice: Morning everyone.',
        '00:00:30Bob: The build is green.',
        '00:01:10Carol: I will update the changelog today.',
        '00:01:40Alice: Thanks, <b>please</b> do.',
      ]);
    });

    it('marks the cited turns, and only those, with the first one as current', async () => {
      const { panel } = await openViewer(jsonResponse(200, around()));

      const list = await within(panel).findByRole('list', { name: 'Transcript' });
      const items = within(list).getAllByRole('listitem');

      expect(items.map((li) => li.getAttribute('data-cited'))).toEqual([
        null,
        'true',
        'true',
        'true',
      ]);
      expect(items[1]).toHaveAttribute('aria-current', 'true');
      expect(items.filter((li) => li.hasAttribute('aria-current'))).toHaveLength(1);
      expect(items[1]!.className).toMatch(/amber/);
      expect(items[0]!.className).not.toMatch(/amber/);
    });

    it('gives each speaker a colour of their own, and the same one every time', async () => {
      const { panel } = await openViewer(jsonResponse(200, around()));

      const list = await within(panel).findByRole('list', { name: 'Transcript' });
      const toneOf = (name: string) => within(list).getAllByText(name)[0]!.className;

      expect(toneOf('Alice')).toMatch(/text-\w+-700/);
      expect(within(list).getAllByText('Alice')).toHaveLength(2);
      expect(within(list).getAllByText('Alice')[0]!.className).toBe(
        within(list).getAllByText('Alice')[1]!.className,
      );
      expect(new Set([toneOf('Alice'), toneOf('Bob'), toneOf('Carol')]).size).toBeGreaterThan(1);
    });

    it('shows the words of the transcript as text, never as markup', async () => {
      const { panel } = await openViewer(jsonResponse(200, around()));

      await within(panel).findByRole('list', { name: 'Transcript' });

      expect(panel).toHaveTextContent('Thanks, <b>please</b> do.');
      expect(panel.querySelector('b')).toBeNull();
    });

    it('leaves out the passage that carries the notes', async () => {
      const { panel } = await openViewer(jsonResponse(200, around()));

      await within(panel).findByRole('list', { name: 'Transcript' });

      expect(panel).not.toHaveTextContent('They planned the release');
      expect(panel).not.toHaveTextContent('Meeting: Release sync');
    });

    it('says when the passage is gone, and shows what was saved with the answer', async () => {
      const { panel } = await openViewer(
        jsonResponse(404, { error: { code: 'not_found', message: 'x' } }),
      );

      expect(await within(panel).findByText(/no longer available/)).toBeInTheDocument();
      expect(panel).toHaveTextContent('[00:01:10] Carol: I will update the changelog today.');
    });

    it('offers to try again when it cannot load', async () => {
      const { panel } = await openViewer(jsonResponse(500, {}));

      expect(await within(panel).findByRole('alert')).toHaveTextContent(
        'Could not load the passage.',
      );
      expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
  });

  describe('the viewer of the notes', () => {
    const notesAround = (): PassagesResponse => ({ ...around(), target: 2 });

    it('shows the notes and not the transcript', async () => {
      const { panel } = await openViewer(jsonResponse(200, notesAround()), undefined, 2, 2);

      expect(await within(panel).findByText(/They planned the release/)).toBeInTheDocument();
      expect(within(panel).queryByRole('list', { name: 'Transcript' })).not.toBeInTheDocument();
      expect(panel).not.toHaveTextContent('Morning everyone');
      expect(panel).toHaveTextContent('Source [2] · Meeting notes · Similarity 51%');
    });
  });
});
