import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { deferredResponse, jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';
import { MAX_TRANSCRIPT_BYTES } from './validation';

const ada = { id: 'u1', email: 'ada@example.com' };

function meeting(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'm1',
    kind: 'transcript',
    filename: 'standup',
    mimeType: 'text/plain',
    sizeBytes: 120,
    status: 'processing',
    error: null,
    pageCount: null,
    chunkCount: 0,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: null,
    participants: ['Alice', 'Bob'],
    durationMs: 85_000,
    notes: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

type Routes = Parameters<typeof stubApi>[0];

function setup(routes: Routes = {}) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
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

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Add a meeting' }));
  return screen.findByRole('dialog', { name: 'Add a meeting' });
};

const fileInput = () => screen.getByLabelText('Transcript file') as HTMLInputElement;
const titleInput = () => screen.getByLabelText('Title (optional)');
const dateInput = () => screen.getByLabelText('Date (optional)');
const submit = () => screen.getByRole('button', { name: 'Add meeting' });
const meetingCalls = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'POST /api/meetings');

function transcript(name = 'standup.txt', size = 100) {
  return new File([new Uint8Array(size).fill(65)], name, { type: 'text/plain' });
}

describe('adding a meeting', () => {
  describe('the dialog', () => {
    it('opens from the documents page and explains what a transcript needs', async () => {
      setup();
      const user = userEvent.setup();

      const dialog = await openDialog(user);

      expect(within(dialog).getByText(/speaker and a time on each turn/)).toHaveTextContent(
        '[00:01:05] Alice: Hello',
      );
      expect(within(dialog).getByText(/\.txt or \.vtt/)).toBeInTheDocument();
      expect(within(dialog).getByLabelText('Transcript file')).toHaveAttribute(
        'accept',
        '.txt,.vtt,text/plain,text/vtt',
      );
      expect(within(dialog).getByLabelText('Title (optional)')).toHaveAttribute(
        'placeholder',
        'Defaults to the file name',
      );
      expect(within(dialog).getByLabelText('Date (optional)')).toHaveAttribute('type', 'date');
      expect(within(dialog).getByText('Up to 1 MB.')).toBeInTheDocument();
    });

    it('does not appear until asked for', async () => {
      setup();

      await screen.findByRole('heading', { name: 'Your documents' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('sits next to the button for repositories', async () => {
      setup();

      expect(await screen.findByRole('button', { name: 'Add a meeting' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add a code repository' })).toBeInTheDocument();
    });

    it('closes with Escape and forgets what was typed and chosen', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());
      await user.type(titleInput(), 'Release sync');
      fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await openDialog(user);

      expect(fileInput().files).toHaveLength(0);
      expect(titleInput()).toHaveValue('');
      expect(dateInput()).toHaveValue('');
    });
  });

  describe('sending a transcript', () => {
    it('sends the file with the given title and date, closes, and lists the meeting as processing', async () => {
      const api = setup({
        'POST /api/meetings': jsonResponse(202, {
          document: meeting({ filename: 'Release sync', meetingHeldOn: '2026-10-01' }),
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(fileInput(), transcript('export-77.txt'));
      await user.type(titleInput(), '  Release sync  ');
      fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });
      await user.click(submit());

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const [call] = meetingCalls(api);
      expect(call?.form?.get('title')).toBe('Release sync');
      expect(call?.form?.get('heldOn')).toBe('2026-10-01');
      expect((call?.form?.get('file') as File).name).toBe('export-77.txt');
      const list = await screen.findByRole('list', { name: 'Documents' });
      expect(within(list).getByText('Release sync')).toBeInTheDocument();
    });

    it('leaves out a title and a date that were not given', async () => {
      const api = setup({ 'POST /api/meetings': jsonResponse(202, { document: meeting() }) });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(fileInput(), transcript('standup.vtt'));
      await user.type(titleInput(), '   ');
      await user.click(submit());

      await waitFor(() => expect(meetingCalls(api)).toHaveLength(1));
      const form = meetingCalls(api)[0]!.form!;
      expect(form.has('title')).toBe(false);
      expect(form.has('heldOn')).toBe(false);
      expect((form.get('file') as File).name).toBe('standup.vtt');
    });

    it('submits with Enter from the title field', async () => {
      const api = setup({ 'POST /api/meetings': jsonResponse(202, { document: meeting() }) });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());

      await user.type(titleInput(), 'Standup{Enter}');

      await waitFor(() => expect(meetingCalls(api)).toHaveLength(1));
    });

    it('limits the title to what the server accepts', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);

      expect(titleInput()).toHaveAttribute('maxlength', '120');
    });

    it('shows that it is working, blocks a second submit and cannot be closed meanwhile', async () => {
      const pending = deferredResponse();
      const api = setup({ 'POST /api/meetings': pending.handler });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());

      await user.click(submit());

      const busy = await screen.findByRole('button', { name: 'Adding…' });
      expect(busy).toBeDisabled();
      expect(fileInput()).toBeDisabled();
      expect(titleInput()).toBeDisabled();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(meetingCalls(api)).toHaveLength(1);

      pending.release(jsonResponse(202, { document: meeting() }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  describe('what it refuses before asking the server', () => {
    it('asks for a file when none is chosen', async () => {
      const api = setup();
      const user = userEvent.setup();
      await openDialog(user);

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('Choose a transcript file.');
      expect(meetingCalls(api)).toEqual([]);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it.each([
      [
        'a file of another type',
        transcript('slides.pdf'),
        'Choose a transcript as a .txt or .vtt file.',
      ],
      ['an empty file', transcript('standup.txt', 0), 'The file is empty.'],
      [
        'a file over the limit',
        transcript('standup.txt', MAX_TRANSCRIPT_BYTES + 1),
        /too large \(limit 1 MB\)/,
      ],
    ])('explains %s, and sends nothing', async (_label, file, message) => {
      const api = setup();
      const user = userEvent.setup({ applyAccept: false });
      await openDialog(user);

      await user.upload(fileInput(), file);
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(meetingCalls(api)).toEqual([]);
    });

    it('takes the message away once a good file is chosen', async () => {
      setup();
      const user = userEvent.setup({ applyAccept: false });
      await openDialog(user);
      await user.upload(fileInput(), transcript('slides.pdf'));
      await screen.findByRole('alert');

      await user.upload(fileInput(), transcript());

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('what the server says', () => {
    it('shows why a file is not a transcript, with the line, and keeps what was typed', async () => {
      setup({
        'POST /api/meetings': jsonResponse(400, {
          error: {
            code: 'invalid_transcript',
            message:
              'Line 1: no line starts with a speaker and a time (for example "[00:01:05] Alice: Hello")',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());
      await user.type(titleInput(), 'Release sync');

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Line 1: no line starts with a speaker and a time',
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(titleInput()).toHaveValue('Release sync');
      expect(fileInput().files?.[0]?.name).toBe('standup.txt');
      expect(submit()).toBeEnabled();
    });

    it('shows the limit when the transcript is too long', async () => {
      setup({
        'POST /api/meetings': jsonResponse(413, {
          error: {
            code: 'file_too_large',
            message: 'The transcript is too long (limit 150,000 characters)',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('limit 150,000 characters');
    });

    it('shows the document limit', async () => {
      setup({
        'POST /api/meetings': jsonResponse(409, {
          error: {
            code: 'document_limit',
            message: 'You have reached the limit of 20 documents. Delete one to add another.',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('limit of 20 documents');
    });

    it('says the server is not responding on a failure that is not the user’s', async () => {
      setup({ 'POST /api/meetings': jsonResponse(503, {}) });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('The server is not responding');
    });

    it('lets the same file be sent again after a failure', async () => {
      let attempts = 0;
      const api = setup({
        'POST /api/meetings': () => {
          attempts += 1;
          return attempts === 1
            ? jsonResponse(503, {})
            : jsonResponse(202, { document: meeting() });
        },
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), transcript());

      await user.click(submit());
      await screen.findByRole('alert');
      await user.click(submit());

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(meetingCalls(api)).toHaveLength(2);
    });
  });

  describe('in the list', () => {
    it('gives the meeting a name in the list even before it has details', async () => {
      setup({
        'GET /api/documents': jsonResponse(200, {
          documents: [meeting({ status: 'ready', chunkCount: 3 })],
        }),
      });

      const list = await screen.findByRole('list', { name: 'Documents' });

      expect(within(list).getByText('standup')).toBeInTheDocument();
    });
  });
});
