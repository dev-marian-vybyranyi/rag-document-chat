import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { deferredResponse, jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';
import { MAX_RESUME_CHARACTERS } from './validation';

const ada = { id: 'u1', email: 'ada@example.com' };

function resume(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'r1',
    kind: 'resume',
    filename: 'cv',
    mimeType: 'application/pdf',
    sizeBytes: 2000,
    status: 'processing',
    error: null,
    pageCount: null,
    chunkCount: 0,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: null,
    participants: null,
    durationMs: null,
    notes: null,
    jobNumber: null,
    profile: null,
    fit: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-14T10:00:00Z',
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
  await user.click(await screen.findByRole('button', { name: 'Add a resume' }));
  return screen.findByRole('dialog', { name: 'Add your resume' });
};

const fileInput = () => screen.getByLabelText('File with the resume') as HTMLInputElement;
const textInput = () => screen.getByLabelText('Text of the resume') as HTMLTextAreaElement;
const submit = () => screen.getByRole('button', { name: 'Add resume' });
const resumeCalls = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'POST /api/career/resume');

function cv(name = 'cv.pdf', size = 100) {
  return new File([new Uint8Array(size).fill(65)], name, { type: 'application/pdf' });
}

describe('adding a resume', () => {
  describe('the dialog', () => {
    it('opens from the documents page and says what happens to the resume', async () => {
      setup();
      const user = userEvent.setup();

      const dialog = await openDialog(user);

      expect(within(dialog).getByText(/One resume at a time/)).toBeInTheDocument();
      expect(within(dialog).getByText(/Email addresses, links, phone numbers/)).toBeInTheDocument();
      expect(within(dialog).getByLabelText('File with the resume')).toHaveAttribute(
        'accept',
        '.pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown',
      );
      expect(within(dialog).getByText('PDF, TXT or Markdown, up to 5 MB.')).toBeInTheDocument();
    });

    it('does not appear until asked for', async () => {
      setup();

      await screen.findByRole('heading', { name: 'Your documents' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('sits next to the other buttons that add something', async () => {
      setup();

      expect(await screen.findByRole('button', { name: 'Add a resume' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Add a job posting' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Add a meeting' })).toBeInTheDocument();
    });

    it('closes with Escape and forgets what was chosen and pasted', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), cv());

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await openDialog(user);

      expect(fileInput().files).toHaveLength(0);
    });

    it('can be switched to pasted text and back, which clears the text', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);

      await user.click(screen.getByRole('radio', { name: 'Paste text' }));
      fireEvent.change(textInput(), { target: { value: 'Alex Morgan' } });
      await user.click(screen.getByRole('radio', { name: 'File' }));
      await user.click(screen.getByRole('radio', { name: 'Paste text' }));

      expect(textInput()).toHaveValue('');
      expect(screen.getByText('Up to 40,000 characters.')).toBeInTheDocument();
    });
  });

  describe('when the user already has a resume', () => {
    it('does not offer to add another, and says how to replace it', async () => {
      setup({
        'GET /api/documents': jsonResponse(200, { documents: [resume({ status: 'ready' })] }),
      });

      const button = await screen.findByRole('button', { name: 'Add a resume' });

      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveAttribute('title', 'Delete your resume to add a different one');
    });

    it('offers it again once the resume is deleted', async () => {
      setup({
        'GET /api/documents': jsonResponse(200, { documents: [resume({ status: 'ready' })] }),
        'DELETE /api/documents/r1': jsonResponse(204),
      });
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Delete cv' }));
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Add a resume' })).toBeEnabled(),
      );
    });
  });

  describe('sending a file', () => {
    it('sends the file, closes, and lists the resume as processing', async () => {
      const api = setup({
        'POST /api/career/resume': jsonResponse(202, { document: resume({ filename: 'cv' }) }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(fileInput(), cv('alex-morgan-cv.pdf'));
      await user.click(submit());

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const [call] = resumeCalls(api);
      expect((call?.form?.get('file') as File).name).toBe('alex-morgan-cv.pdf');
      expect(call?.form?.has('title')).toBe(false);
      const list = await screen.findByRole('list', { name: 'Documents' });
      expect(within(list).getByText('cv')).toBeInTheDocument();
    });

    it('shows that it is working, blocks a second submit and cannot be closed meanwhile', async () => {
      const pending = deferredResponse();
      const api = setup({ 'POST /api/career/resume': pending.handler });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), cv());

      await user.click(submit());

      const busy = await screen.findByRole('button', { name: 'Adding…' });
      expect(busy).toBeDisabled();
      expect(fileInput()).toBeDisabled();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(resumeCalls(api)).toHaveLength(1);

      pending.release(jsonResponse(202, { document: resume() }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  describe('sending pasted text', () => {
    it('sends the text as a plain text file', async () => {
      const api = setup({ 'POST /api/career/resume': jsonResponse(202, { document: resume() }) });
      const user = userEvent.setup();
      await openDialog(user);

      await user.click(screen.getByRole('radio', { name: 'Paste text' }));
      fireEvent.change(textInput(), { target: { value: 'Alex Morgan\nGo, Rust' } });
      await user.click(submit());

      await waitFor(() => expect(resumeCalls(api)).toHaveLength(1));
      const sent = resumeCalls(api)[0]!.form!.get('file') as File;
      expect(sent.name).toBe('Resume.txt');
      expect(sent.type).toBe('text/plain');
      expect(await sent.text()).toBe('Alex Morgan\nGo, Rust');
    });

    it('asks for text when there is none', async () => {
      const api = setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.click(screen.getByRole('radio', { name: 'Paste text' }));

      fireEvent.change(textInput(), { target: { value: '   ' } });
      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Choose a file or paste the text of your resume.',
      );
      expect(resumeCalls(api)).toEqual([]);
    });

    it('refuses text over the limit and says so while it is typed', async () => {
      const api = setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.click(screen.getByRole('radio', { name: 'Paste text' }));

      fireEvent.change(textInput(), { target: { value: 'a'.repeat(MAX_RESUME_CHARACTERS + 1) } });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The text is too long (limit 40,000 characters).',
      );
      await user.click(submit());
      expect(resumeCalls(api)).toEqual([]);

      fireEvent.change(textInput(), { target: { value: 'a'.repeat(MAX_RESUME_CHARACTERS) } });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('what it refuses before asking the server', () => {
    it('asks for a file when none is chosen', async () => {
      const api = setup();
      const user = userEvent.setup();
      await openDialog(user);

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Choose a file or paste the text of your resume.',
      );
      expect(resumeCalls(api)).toEqual([]);
    });

    it.each([
      [
        'a file of another type',
        cv('cv.docx'),
        'Choose the resume as a PDF, TXT or Markdown file.',
      ],
      ['an empty file', cv('cv.pdf', 0), 'The file is empty.'],
      [
        'a file over the limit',
        cv('cv.pdf', 5 * 1024 * 1024 + 1),
        'The file is too large (limit 5 MB).',
      ],
    ])('explains %s, and sends nothing', async (_label, file, message) => {
      const api = setup();
      const user = userEvent.setup({ applyAccept: false });
      await openDialog(user);

      await user.upload(fileInput(), file);
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(resumeCalls(api)).toEqual([]);
    });

    it('takes the message away once a good file is chosen', async () => {
      setup();
      const user = userEvent.setup({ applyAccept: false });
      await openDialog(user);
      await user.upload(fileInput(), cv('cv.docx'));
      await screen.findByRole('alert');

      await user.upload(fileInput(), cv());

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('what the server says', () => {
    it('says a resume is there already, and keeps the dialog open with the file', async () => {
      setup({
        'POST /api/career/resume': jsonResponse(409, {
          error: {
            code: 'resume_exists',
            message: 'You already have a resume. Delete it to add a different one.',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), cv());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('You already have a resume');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(fileInput().files?.[0]?.name).toBe('cv.pdf');
      expect(submit()).toBeEnabled();
    });

    it('shows why a file cannot be read', async () => {
      setup({
        'POST /api/career/resume': jsonResponse(400, {
          error: { code: 'invalid_file', message: 'The PDF has no text we can read.' },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), cv());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('The PDF has no text');
    });

    it('shows the document limit', async () => {
      setup({
        'POST /api/career/resume': jsonResponse(409, {
          error: {
            code: 'document_limit',
            message: 'You have reached the limit of 20 documents. Delete one to add another.',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), cv());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('limit of 20 documents');
    });

    it('says the server is not responding on a failure that is not the user’s', async () => {
      setup({ 'POST /api/career/resume': jsonResponse(503, {}) });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), cv());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('The server is not responding');
    });
  });
});
