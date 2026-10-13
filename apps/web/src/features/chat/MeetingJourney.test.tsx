import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { answerChunks, jsonResponse, sseResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem, MeetingNotes } from '../documents/api';

vi.mock('../documents/polling', () => ({ pollDelay: () => 15 }));

const ada = { id: 'u1', email: 'ada@example.com' };
const QUESTION = 'What is Carol responsible for in Release sync?';

const notes: MeetingNotes = {
  summary: 'The team settled the marketing budget.',
  topics: ['Marketing budget'],
  decisions: [
    { text: 'Increase the marketing budget by fifty percent.', startMs: 150_000, evidence: 'x' },
  ],
  actionItems: [
    {
      task: 'Book the venue for the kickoff.',
      owner: 'Carol',
      due: null,
      startMs: 250_000,
      evidence: 'z',
    },
    {
      task: 'Send the revised budget spreadsheet to finance.',
      owner: 'Bob',
      due: 'Friday',
      startMs: 230_000,
      evidence: 'y',
    },
  ],
  openQuestions: ['Who approves the venue contract?'],
};

function meeting(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'm1',
    kind: 'transcript',
    filename: 'Release sync',
    mimeType: 'text/plain',
    sizeBytes: 900,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 5,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: '2026-10-01',
    participants: ['Alice', 'Bob', 'Carol'],
    durationMs: 285_000,
    notes,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

const arriving = (progress: DocumentItem['progress']) =>
  meeting({ status: 'processing', progress, chunkCount: 0, notes: null });

const speakers = ['Alice', 'Bob', 'Carol'];

const spoken = {
  id: 1,
  chunkId: 'k1',
  documentId: 'm1',
  filename: 'Release sync',
  page: null,
  meeting: { startMs: 210_000, endMs: 270_000, speakers },
  ordinal: 3,
  excerpt: '[00:04:10] Carol: I will book the venue for the kickoff.',
  score: 0.74,
};

const notesSource = {
  id: 2,
  chunkId: 'k2',
  documentId: 'm1',
  filename: 'Release sync',
  page: null,
  meeting: { startMs: null, endMs: null, speakers },
  ordinal: 4,
  excerpt: 'Meeting notes: Release sync (2026-10-01)',
  score: 0.66,
};

const retrieval = {
  query: QUESTION,
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.74,
  threshold: 0.3,
  outcome: 'answered',
  filters: { speakers: ['Carol'], time: null, relaxed: false },
};

const header = 'Meeting: Release sync (2026-10-01)';
const passages = {
  document: {
    id: 'm1',
    filename: 'Release sync',
    pageCount: null,
    kind: 'transcript',
    repoUrl: null,
    commitSha: null,
  },
  target: 3,
  passages: [
    {
      ordinal: 2,
      page: null,
      meeting: { startMs: 150_000, endMs: 215_000, speakers },
      content: `${header}\n[00:02:30] Alice: Let us compromise. We increase the marketing budget by fifty percent.\n[00:03:30] Alice: Decision made. Bob, please send the spreadsheet by Friday.`,
    },
    {
      ordinal: 3,
      page: null,
      meeting: { startMs: 210_000, endMs: 270_000, speakers },
      content: `${header}\n[00:03:30] Alice: Decision made. Bob, please send the spreadsheet by Friday.\n[00:04:10] Carol: I will book the venue for the kickoff.`,
    },
    {
      ordinal: 4,
      page: null,
      meeting: { startMs: null, endMs: null, speakers },
      content:
        'Meeting notes: Release sync (2026-10-01)\nSummary: The team settled the marketing budget.',
    },
  ],
};

const PASSAGES = 'GET /api/documents/m1/passages?ordinal=3&radius=2';
const NOTES_PASSAGES = 'GET /api/documents/m1/passages?ordinal=4&radius=2';
const CHAT = {
  id: 'c9',
  title: 'New chat',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:00:00Z',
};

function sequence(...responses: Array<() => Response>) {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)]!();
}

const times = (count: number, response: () => Response) =>
  Array.from({ length: count }, () => response);
const listOf = (documents: DocumentItem[]) => () => jsonResponse(200, { documents });

function setup(routes: Parameters<typeof stubApi>[0], path = '/documents') {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
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

const transcriptFile = (name = 'export-77.txt') =>
  new File(['[00:00:05] Alice: Hello.\n[00:00:09] Bob: Hi.'], name, { type: 'text/plain' });

function conversation(
  extra: object[] = [],
  answer = 'Carol books the venue [1]. The notes list it too [2].',
) {
  return {
    chat: CHAT,
    messages: [
      { id: 'm1', role: 'user', content: QUESTION, sources: [], retrieval: null, createdAt: 'x' },
      {
        id: 'm2',
        role: 'assistant',
        content: answer,
        sources: [spoken, notesSource],
        retrieval,
        createdAt: 'x',
      },
      ...extra,
    ],
  };
}

describe('from a transcript to the moment that answers a question', () => {
  it('adds a meeting, reads its notes, asks a suggested question and reads the cited moment', async () => {
    const api = setup({
      'GET /api/documents': sequence(
        listOf([]),
        ...times(8, listOf([arriving({ phase: 'analyzing', done: 0, total: 0 })])),
        ...times(8, listOf([arriving({ phase: 'embedding', done: 100, total: 150 })])),
        listOf([meeting()]),
      ),
      'POST /api/meetings': () => jsonResponse(202, { document: arriving(null) }),
      'POST /api/chats': jsonResponse(201, { chat: CHAT }),
      'GET /api/chats/c9': jsonResponse(200, { chat: CHAT, messages: [] }),
      'POST /api/chats/c9/messages': () =>
        sseResponse(
          answerChunks(
            ['Carol books the venue [1]. The notes list it too [2].'],
            [spoken, notesSource],
            retrieval,
          ),
        ),
      [PASSAGES]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add a meeting' }));
    await user.upload(await screen.findByLabelText('Transcript file'), transcriptFile());
    await user.type(screen.getByLabelText('Title (optional)'), 'Release sync');
    await user.type(screen.getByLabelText('Date (optional)'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Add meeting' }));

    const library = await screen.findByRole('list', { name: 'Documents' });
    const card = within(library).getByText('Release sync').closest('li')!;
    await waitFor(() => expect(card).toHaveTextContent('Writing the notes…'));
    await waitFor(() => expect(card).toHaveTextContent('Indexing: 100 of 150 passages'));
    await waitFor(() =>
      expect(card).toHaveTextContent(
        '1 Oct 2026 · 5 min · 3 speakers · 5 passages · 1 decision · 2 action items',
      ),
    );
    const form = api.calls.find((c) => c.route === 'POST /api/meetings')?.form;
    expect(form?.get('title')).toBe('Release sync');
    expect(form?.get('heldOn')).toBe('2026-10-01');
    expect((form?.get('file') as File).name).toBe('export-77.txt');

    await user.click(within(card).getByRole('button', { name: 'Notes for Release sync' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release sync' });
    expect(within(dialog).getByRole('list', { name: 'Action items' })).toHaveTextContent(
      'Owner: Bob · Due: Friday',
    );
    expect(within(dialog).getByRole('list', { name: 'Decisions' })).toHaveTextContent(
      'Increase the marketing budget by fifty percent.',
    );
    await user.keyboard('{Escape}');

    await user.click(within(card).getByRole('button', { name: QUESTION }));

    expect(api.calls.find((c) => c.route === 'POST /api/chats')?.body).toEqual({
      sourceIds: ['m1'],
    });
    const citation = await screen.findByRole('button', {
      name: 'Source 1: Release sync · 00:03:30 · Alice, Bob +1',
    });
    expect(
      screen.getByRole('button', { name: /\[1\] Release sync · 00:03:30 · Alice, Bob \+1/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\[2\] Release sync · notes/ })).toBeInTheDocument();

    await user.click(citation);
    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    const transcript = await within(viewer).findByRole('list', { name: 'Transcript' });
    expect(within(viewer).getByRole('heading', { name: 'Release sync' })).toBeInTheDocument();
    const rows = within(transcript).getAllByRole('listitem');
    expect(rows.map((r) => [r.textContent, r.getAttribute('data-cited')])).toEqual([
      [
        '00:02:30Alice: Let us compromise. We increase the marketing budget by fifty percent.',
        null,
      ],
      ['00:03:30Alice: Decision made. Bob, please send the spreadsheet by Friday.', 'true'],
      ['00:04:10Carol: I will book the venue for the kickoff.', 'true'],
    ]);
    expect(rows[1]).toHaveAttribute('aria-current', 'true');

    await user.click(within(viewer).getByRole('button', { name: /Close/ }));
    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();
    expect(citation).toHaveFocus();
  });

  it('explains why a file is not a transcript, and takes a better one', async () => {
    let attempts = 0;
    const api = setup({
      'GET /api/documents': sequence(listOf([]), listOf([meeting()])),
      'POST /api/meetings': () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(400, {
              error: {
                code: 'invalid_transcript',
                message:
                  'Line 1: no line starts with a speaker and a time (for example "[00:01:05] Alice: Hello")',
              },
            })
          : jsonResponse(202, { document: meeting() });
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add a meeting' }));
    await user.upload(await screen.findByLabelText('Transcript file'), transcriptFile('notes.txt'));
    await user.click(screen.getByRole('button', { name: 'Add meeting' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Line 1: no line starts with a speaker',
    );
    await user.upload(screen.getByLabelText('Transcript file'), transcriptFile('standup.txt'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add meeting' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls.filter((c) => c.route === 'POST /api/meetings')).toHaveLength(2);
    const library = await screen.findByRole('list', { name: 'Documents' });
    expect(within(library).getByText('Release sync')).toBeInTheDocument();
  });

  it('shows the same citations, the same moment and the same notes when the conversation is opened again', async () => {
    setup(
      {
        'GET /api/documents': jsonResponse(200, { documents: [meeting()] }),
        'GET /api/chats': jsonResponse(200, { chats: [CHAT] }),
        'GET /api/chats/c9': jsonResponse(200, conversation()),
        [PASSAGES]: jsonResponse(200, passages),
        [NOTES_PASSAGES]: jsonResponse(200, { ...passages, target: 4 }),
      },
      '/chats/c9',
    );
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', {
        name: 'Source 1: Release sync · 00:03:30 · Alice, Bob +1',
      }),
    );
    let viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(await within(viewer).findByRole('list', { name: 'Transcript' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Source 2: Release sync · notes' }));
    viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(
      await within(viewer).findByText(/The team settled the marketing budget/),
    ).toBeInTheDocument();
    expect(within(viewer).queryByRole('list', { name: 'Transcript' })).not.toBeInTheDocument();
    expect(viewer).toHaveTextContent('Meeting notes');
  });

  it('explains an answer: who and what it was limited to, and which moments the model was given', async () => {
    setup(
      {
        'GET /api/documents': jsonResponse(200, { documents: [meeting()] }),
        'GET /api/chats': jsonResponse(200, { chats: [CHAT] }),
        'GET /api/chats/c9': jsonResponse(200, conversation()),
      },
      '/chats/c9',
    );
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole('button', { name: 'Why this answer?' }))[0]!);

    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(panel).toHaveTextContent('Limited to what Carol said, as your question asked.');
    const given = within(panel).getByText('Passages the model was given').closest('section')!;
    expect(given).toHaveTextContent('[1] Release sync · 00:03:30 · Alice, Bob +1');
    expect(given).toHaveTextContent('[2] Release sync · notes');
  });

  it('names the moments of a refusal, and says the limit was widened', async () => {
    const declined = {
      ...retrieval,
      bestScore: 0.21,
      outcome: 'declined',
      filters: { speakers: ['Carol'], time: 'after 02:00:00', relaxed: true },
      closest: [{ filename: 'Release sync', page: null, meeting: spoken.meeting, score: 0.21 }],
    };
    setup(
      {
        'GET /api/documents': jsonResponse(200, { documents: [meeting()] }),
        'GET /api/chats': jsonResponse(200, { chats: [CHAT] }),
        'GET /api/chats/c9': jsonResponse(200, {
          chat: CHAT,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'What is the weather?',
              sources: [],
              retrieval: null,
              createdAt: 'x',
            },
            {
              id: 'm2',
              role: 'assistant',
              content: "I couldn't find this in your documents.",
              sources: [],
              retrieval: declined,
              createdAt: 'x',
            },
          ],
        }),
      },
      '/chats/c9',
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Why this answer?' }));

    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(panel).toHaveTextContent('so the search was widened to the whole meeting');
    expect(
      within(panel).getByText('Closest passages (not used)').closest('section'),
    ).toHaveTextContent('Release sync · 00:03:30 · Alice, Bob +1');
  });
});
