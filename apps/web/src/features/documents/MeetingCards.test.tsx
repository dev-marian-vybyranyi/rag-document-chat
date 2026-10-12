import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { deferredResponse, jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem, MeetingNotes } from './api';

vi.mock('./polling', () => ({ pollDelay: () => 15 }));

const ada = { id: 'u1', email: 'ada@example.com' };

const notes: MeetingNotes = {
  summary: 'The team planned the release.',
  topics: ['Release', 'Roadmap'],
  decisions: [{ text: 'Ship on Friday.', startMs: 120_000, evidence: 'we ship on Friday' }],
  actionItems: [
    { task: 'Update the changelog.', owner: 'Carol', due: 'today', startMs: 70_000, evidence: 'x' },
    { task: 'Book the room.', owner: null, due: null, startMs: 3_725_000, evidence: 'y' },
  ],
  openQuestions: ['Who pays for the launch?'],
};

function meeting(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'm1',
    kind: 'transcript',
    filename: 'Release sync',
    mimeType: 'text/plain',
    sizeBytes: 1200,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 12,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: '2026-10-01',
    participants: ['Alice', 'Bob', 'Carol'],
    durationMs: 3_900_000,
    notes,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

type Routes = Parameters<typeof stubApi>[0];

function setup(documents: DocumentItem[], routes: Routes = {}) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
    'GET /api/documents': jsonResponse(200, { documents }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/documents']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

const card = async (name = 'Release sync') =>
  within(await screen.findByRole('list', { name: 'Documents', hidden: true }))
    .getByText(name)
    .closest('li')!;

const openNotes = async (user: ReturnType<typeof userEvent.setup>, name = 'Release sync') => {
  await user.click(await screen.findByRole('button', { name: `Notes for ${name}` }));
  return screen.findByRole('dialog', { name });
};

describe('the card of a meeting', () => {
  it('names the date, the length, who spoke, and what the notes found', async () => {
    setup([meeting()]);

    const li = await card();

    expect(li).toHaveTextContent(
      '1 Oct 2026 · 1 h 05 min · 3 speakers · 12 passages · 1 decision · 2 action items',
    );
    expect(li).not.toHaveTextContent('KB');
    const speakers = within(li).getByRole('list', { name: 'Speakers in Release sync' });
    expect(
      within(speakers)
        .getAllByRole('listitem')
        .map((s) => s.textContent),
    ).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('shows only the first speakers of a big meeting and counts the others', async () => {
    const names = Array.from({ length: 11 }, (_, i) => `Person${i}`);
    setup([meeting({ participants: names })]);

    const li = await card();

    const speakers = within(li).getByRole('list', { name: 'Speakers in Release sync' });
    expect(within(speakers).getAllByRole('listitem')).toHaveLength(9);
    expect(speakers).toHaveTextContent('+3 more');
    expect(speakers).not.toHaveTextContent('Person8');
  });

  it('leaves out the notes counts when there are no notes', async () => {
    setup([meeting({ notes: null })]);

    const li = await card();

    expect(li).toHaveTextContent('1 Oct 2026 · 1 h 05 min · 3 speakers · 12 passages');
    expect(li).not.toHaveTextContent('decision');
  });

  it('does not show an invented date when the meeting has none', async () => {
    setup([meeting({ meetingHeldOn: null })]);

    const li = await card();

    expect(li).toHaveTextContent('1 h 05 min · 3 speakers');
    expect(li).not.toHaveTextContent('Oct');
  });

  describe('while it is being processed', () => {
    it('says it is writing the notes, with an indeterminate bar, and has no notes button yet', async () => {
      setup([
        meeting({
          status: 'processing',
          notes: null,
          chunkCount: 0,
          progress: { phase: 'analyzing', done: 0, total: 0 },
        }),
      ]);

      const li = await card();

      expect(li).toHaveTextContent('Writing the notes…');
      const bar = within(li).getByRole('progressbar', { name: 'Processing Release sync' });
      expect(bar).not.toHaveAttribute('aria-valuenow');
      expect(screen.queryByRole('button', { name: /Notes for/ })).not.toBeInTheDocument();
      expect(
        within(li).getByRole('list', { name: 'Speakers in Release sync' }),
      ).toBeInTheDocument();
    });

    it('counts the passages while they are embedded', async () => {
      setup([
        meeting({
          status: 'processing',
          notes: null,
          progress: { phase: 'embedding', done: 100, total: 150 },
        }),
      ]);

      const li = await card();

      expect(li).toHaveTextContent('Indexing: 100 of 150 passages');
      expect(within(li).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '67');
    });

    it('becomes ready by itself, with its notes', async () => {
      let polls = 0;
      setup([meeting({ status: 'processing', notes: null, progress: null })], {
        'GET /api/documents': () => {
          polls += 1;
          return jsonResponse(200, {
            documents: [polls === 1 ? meeting({ status: 'processing', notes: null }) : meeting()],
          });
        },
      });

      expect(
        await screen.findByRole('button', { name: 'Notes for Release sync' }),
      ).toBeInTheDocument();
      expect(await card()).toHaveTextContent('1 decision · 2 action items');
    });
  });

  it('shows why a meeting failed', async () => {
    setup([
      meeting({
        status: 'failed',
        notes: null,
        error: 'The embedding service is busy. Try again in a minute.',
      }),
    ]);

    const li = await card();

    expect(li).toHaveTextContent('Failed');
    expect(li).toHaveTextContent('The embedding service is busy');
    expect(screen.queryByRole('button', { name: /Notes for/ })).not.toBeInTheDocument();
  });

  it('can be deleted like any other document', async () => {
    const api = setup([meeting()], { 'DELETE /api/documents/m1': jsonResponse(204) });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete Release sync' }));
    expect(
      screen.queryByRole('button', { name: 'Notes for Release sync' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(api.calls.map((c) => c.route)).toContain('DELETE /api/documents/m1'),
    );
    await waitFor(() => expect(screen.queryByText('Release sync')).not.toBeInTheDocument());
  });
});

describe('the notes of a meeting', () => {
  it('opens from the card and lists everything the notes found', async () => {
    setup([meeting()]);
    const user = userEvent.setup();

    const dialog = await openNotes(user);

    expect(within(dialog).getByText(/1 decision · 2 action items\./)).toBeInTheDocument();
    expect(within(dialog).getByText('The team planned the release.')).toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: 'Topics' })).toHaveTextContent(
      'ReleaseRoadmap',
    );
    const decisions = within(dialog).getByRole('list', { name: 'Decisions' });
    expect(decisions).toHaveTextContent('00:02:00');
    expect(decisions).toHaveTextContent('Ship on Friday.');
    const items = within(within(dialog).getByRole('list', { name: 'Action items' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('00:01:10');
    expect(items[0]).toHaveTextContent('Update the changelog.');
    expect(items[0]).toHaveTextContent('Owner: Carol · Due: today');
    expect(items[1]).toHaveTextContent('01:02:05');
    expect(items[1]).toHaveTextContent('Book the room.');
    expect(items[1]).toHaveTextContent('No owner stated');
    expect(items[1]).not.toHaveTextContent('Due');
    expect(within(dialog).getByRole('list', { name: 'Open questions' })).toHaveTextContent(
      'Who pays for the launch?',
    );
  });

  it('says how the notes were made and checked', async () => {
    setup([meeting()]);
    const user = userEvent.setup();

    const dialog = await openNotes(user);

    expect(dialog).toHaveTextContent('Written by a model from the transcript');
    expect(dialog).toHaveTextContent('checked against what was said');
  });

  it('leaves out the sections that are empty', async () => {
    setup([meeting({ notes: { ...notes, topics: [], decisions: [], openQuestions: [] } })]);
    const user = userEvent.setup();

    const dialog = await openNotes(user);

    expect(within(dialog).queryByRole('heading', { name: 'Decisions' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Topics' })).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('heading', { name: 'Open questions' }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Action items' })).toBeInTheDocument();
  });

  it('says plainly when the notes found nothing', async () => {
    setup([
      meeting({
        notes: { summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] },
      }),
    ]);
    const user = userEvent.setup();

    const dialog = await openNotes(user);

    expect(dialog).toHaveTextContent('Nothing worth noting was found.');
  });

  it('shows text from the transcript as text, not as markup', async () => {
    setup([
      meeting({
        notes: {
          ...notes,
          summary: '<img src=x onerror=alert(1)> **bold**',
          decisions: [],
          actionItems: [],
        },
      }),
    ]);
    const user = userEvent.setup();

    const dialog = await openNotes(user);

    expect(within(dialog).getByText('<img src=x onerror=alert(1)> **bold**')).toBeInTheDocument();
    expect(dialog.querySelector('img')).toBeNull();
  });

  describe('copying', () => {
    it('puts the notes on the clipboard as Markdown', async () => {
      setup([meeting()]);
      const user = userEvent.setup();
      const dialog = await openNotes(user);

      await user.click(within(dialog).getByRole('button', { name: 'Copy as Markdown' }));

      expect(await within(dialog).findByText('Copied.')).toBeInTheDocument();
      const text = await navigator.clipboard.readText();
      expect(text).toContain('# Release sync (1 Oct 2026)');
      expect(text).toContain('- [ ] [00:01:10] Update the changelog. (Carol, due: today)');
    });

    it('says so when the browser will not copy', async () => {
      setup([meeting()]);
      const user = userEvent.setup();
      const dialog = await openNotes(user);
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

      await user.click(within(dialog).getByRole('button', { name: 'Copy as Markdown' }));

      expect(await within(dialog).findByText(/Could not copy/)).toBeInTheDocument();
    });

    it('is not offered when there are no notes', async () => {
      setup([meeting({ notes: null })]);
      const user = userEvent.setup();

      const dialog = await openNotes(user);

      expect(
        within(dialog).queryByRole('button', { name: 'Copy as Markdown' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('writing them', () => {
    it('offers to generate them when there are none, and shows them when they come', async () => {
      const api = setup([meeting({ notes: null })], {
        'POST /api/meetings/m1/notes': jsonResponse(200, { document: meeting() }),
      });
      const user = userEvent.setup();
      const dialog = await openNotes(user);
      expect(dialog).toHaveTextContent('There are no notes for this meeting yet.');

      await user.click(within(dialog).getByRole('button', { name: 'Generate notes' }));

      expect(await within(dialog).findByText('The team planned the release.')).toBeInTheDocument();
      expect(api.calls.filter((c) => c.route === 'POST /api/meetings/m1/notes')).toHaveLength(1);
      expect(
        within(dialog).getByRole('button', { name: 'Write the notes again' }),
      ).toBeInTheDocument();
      expect(await card()).toHaveTextContent('1 decision · 2 action items');
    });

    it('writes them again and replaces what was there', async () => {
      setup([meeting()], {
        'POST /api/meetings/m1/notes': jsonResponse(200, {
          document: meeting({ notes: { ...notes, summary: 'A better summary.' } }),
        }),
      });
      const user = userEvent.setup();
      const dialog = await openNotes(user);

      await user.click(within(dialog).getByRole('button', { name: 'Write the notes again' }));

      expect(await within(dialog).findByText('A better summary.')).toBeInTheDocument();
      expect(within(dialog).queryByText('The team planned the release.')).not.toBeInTheDocument();
    });

    it('shows that it is working, blocks a second click and cannot be closed meanwhile', async () => {
      const pending = deferredResponse();
      const api = setup([meeting({ notes: null })], {
        'POST /api/meetings/m1/notes': pending.handler,
      });
      const user = userEvent.setup();
      const dialog = await openNotes(user);

      await user.click(within(dialog).getByRole('button', { name: 'Generate notes' }));

      const busy = await within(dialog).findByRole('button', { name: 'Writing notes…' });
      expect(busy).toBeDisabled();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.calls.filter((c) => c.route === 'POST /api/meetings/m1/notes')).toHaveLength(1);

      pending.release(jsonResponse(200, { document: meeting() }));
      expect(await within(dialog).findByText('The team planned the release.')).toBeInTheDocument();
    });

    it.each([
      [
        'when the model is busy',
        jsonResponse(503, {
          error: {
            code: 'ai_busy',
            message: 'The notes could not be generated right now. Try again in a minute.',
          },
        }),
        'could not be generated right now',
      ],
      [
        'when the meeting uses another embedding model',
        jsonResponse(409, {
          error: {
            code: 'conflict',
            message: 'This meeting was indexed with a different embedding model. Upload it again.',
          },
        }),
        'different embedding model',
      ],
    ])('says why it could not %s, and keeps the old notes', async (_label, response, message) => {
      setup([meeting()], { 'POST /api/meetings/m1/notes': response });
      const user = userEvent.setup();
      const dialog = await openNotes(user);

      await user.click(within(dialog).getByRole('button', { name: 'Write the notes again' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
      expect(within(dialog).getByText('The team planned the release.')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Write the notes again' })).toBeEnabled();
    });

    it('forgets an old message when the dialog is closed and opened again', async () => {
      setup([meeting()], { 'POST /api/meetings/m1/notes': jsonResponse(503, {}) });
      const user = userEvent.setup();
      const dialog = await openNotes(user);
      await user.click(within(dialog).getByRole('button', { name: 'Write the notes again' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'The server is not responding',
      );

      await user.keyboard('{Escape}');
      const again = await openNotes(user);

      expect(within(again).queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
