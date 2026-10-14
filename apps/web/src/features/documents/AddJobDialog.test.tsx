import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { deferredResponse, jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';
import { MAX_JOB_CHARACTERS } from './validation';

const ada = { id: 'u1', email: 'ada@example.com' };

function job(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'j1',
    kind: 'job_posting',
    filename: 'Platform Engineer at Acme',
    mimeType: 'text/plain',
    sizeBytes: 800,
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
    jobNumber: 1,
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
  await user.click(await screen.findByRole('button', { name: 'Add a job posting' }));
  return screen.findByRole('dialog', { name: 'Add a job posting' });
};

const fileInput = () => screen.getByLabelText('File with the job posting') as HTMLInputElement;
const textInput = () => screen.getByLabelText('Text of the job posting') as HTMLTextAreaElement;
const titleInput = () => screen.getByLabelText('Job title (optional)');
const companyInput = () => screen.getByLabelText('Company (optional)');
const submit = () => screen.getByRole('button', { name: 'Add job posting' });
const jobCalls = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'POST /api/career/jobs');

function posting(name = 'platform.txt', size = 100) {
  return new File([new Uint8Array(size).fill(65)], name, { type: 'text/plain' });
}

describe('adding a job posting', () => {
  describe('the dialog', () => {
    it('opens from the documents page and says that postings are numbered', async () => {
      setup();
      const user = userEvent.setup();

      const dialog = await openDialog(user);

      expect(within(dialog).getByText(/Job #2/)).toBeInTheDocument();
      expect(within(dialog).getByText(/Up to 10 postings/)).toBeInTheDocument();
      expect(within(dialog).getByLabelText('File with the job posting')).toHaveAttribute(
        'accept',
        '.pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown',
      );
      expect(within(dialog).getByText('PDF, TXT or Markdown, up to 1 MB.')).toBeInTheDocument();
      expect(titleInput()).toHaveAttribute('placeholder', 'Defaults to the file name');
    });

    it('limits the title and the company to what the server accepts', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);

      expect(titleInput()).toHaveAttribute('maxlength', '120');
      expect(companyInput()).toHaveAttribute('maxlength', '80');
    });

    it('closes with Escape and forgets what was typed and chosen', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), posting());
      await user.type(titleInput(), 'Platform Engineer');
      await user.type(companyInput(), 'Acme');

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await openDialog(user);

      expect(fileInput().files).toHaveLength(0);
      expect(titleInput()).toHaveValue('');
      expect(companyInput()).toHaveValue('');
    });
  });

  describe('sending a file', () => {
    it('sends the file with the given title and company, closes, and lists the posting', async () => {
      const api = setup({ 'POST /api/career/jobs': jsonResponse(202, { document: job() }) });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(fileInput(), posting('export-9.txt'));
      await user.type(titleInput(), '  Platform Engineer  ');
      await user.type(companyInput(), ' Acme ');
      await user.click(submit());

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const [call] = jobCalls(api);
      expect(call?.form?.get('title')).toBe('Platform Engineer');
      expect(call?.form?.get('company')).toBe('Acme');
      expect((call?.form?.get('file') as File).name).toBe('export-9.txt');
      const list = await screen.findByRole('list', { name: 'Documents' });
      expect(within(list).getByText('Job #1 · Platform Engineer at Acme')).toBeInTheDocument();
    });

    it('leaves out a title and a company that were not given', async () => {
      const api = setup({ 'POST /api/career/jobs': jsonResponse(202, { document: job() }) });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(fileInput(), posting('platform.md'));
      await user.type(titleInput(), '   ');
      await user.click(submit());

      await waitFor(() => expect(jobCalls(api)).toHaveLength(1));
      const form = jobCalls(api)[0]!.form!;
      expect(form.has('title')).toBe(false);
      expect(form.has('company')).toBe(false);
    });

    it('accepts a file of exactly the size limit', async () => {
      const api = setup({ 'POST /api/career/jobs': jsonResponse(202, { document: job() }) });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(fileInput(), posting('job.txt', 1_000_000));
      await user.click(submit());

      await waitFor(() => expect(jobCalls(api)).toHaveLength(1));
    });

    it('submits with Enter from the company field', async () => {
      const api = setup({ 'POST /api/career/jobs': jsonResponse(202, { document: job() }) });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), posting());

      await user.type(companyInput(), 'Acme{Enter}');

      await waitFor(() => expect(jobCalls(api)).toHaveLength(1));
    });

    it('shows that it is working, blocks a second submit and cannot be closed meanwhile', async () => {
      const pending = deferredResponse();
      const api = setup({ 'POST /api/career/jobs': pending.handler });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), posting());

      await user.click(submit());

      const busy = await screen.findByRole('button', { name: 'Adding…' });
      expect(busy).toBeDisabled();
      expect(fileInput()).toBeDisabled();
      expect(titleInput()).toBeDisabled();
      expect(companyInput()).toBeDisabled();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(jobCalls(api)).toHaveLength(1);

      pending.release(jsonResponse(202, { document: job() }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  describe('sending pasted text', () => {
    it('sends the text as a plain text file with the title that was typed', async () => {
      const api = setup({ 'POST /api/career/jobs': jsonResponse(202, { document: job() }) });
      const user = userEvent.setup();
      await openDialog(user);

      await user.click(screen.getByRole('radio', { name: 'Paste text' }));
      fireEvent.change(textInput(), { target: { value: 'Platform Engineer\nRequirements\n- Go' } });
      await user.type(titleInput(), 'Platform Engineer');
      await user.click(submit());

      await waitFor(() => expect(jobCalls(api)).toHaveLength(1));
      const form = jobCalls(api)[0]!.form!;
      const sent = form.get('file') as File;
      expect(sent.name).toBe('Job posting.txt');
      expect(sent.type).toBe('text/plain');
      expect(await sent.text()).toBe('Platform Engineer\nRequirements\n- Go');
      expect(form.get('title')).toBe('Platform Engineer');
    });

    it('refuses text over the limit', async () => {
      const api = setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.click(screen.getByRole('radio', { name: 'Paste text' }));

      fireEvent.change(textInput(), { target: { value: 'a'.repeat(MAX_JOB_CHARACTERS + 1) } });
      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The text is too long (limit 25,000 characters).',
      );
      expect(screen.getByText('Up to 25,000 characters.')).toBeInTheDocument();
      expect(jobCalls(api)).toEqual([]);
    });
  });

  describe('what it refuses before asking the server', () => {
    it('asks for a file or text when none is given', async () => {
      const api = setup();
      const user = userEvent.setup();
      await openDialog(user);

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Choose a file or paste the text of the job posting.',
      );
      expect(jobCalls(api)).toEqual([]);
    });

    it.each([
      [
        'a file of another type',
        posting('job.docx'),
        'Choose the job posting as a PDF, TXT or Markdown file.',
      ],
      ['an empty file', posting('job.txt', 0), 'The file is empty.'],
      [
        'a file over the limit',
        posting('job.txt', 1_000_001),
        'The file is too large (limit 1 MB).',
      ],
    ])('explains %s, and sends nothing', async (_label, file, message) => {
      const api = setup();
      const user = userEvent.setup({ applyAccept: false });
      await openDialog(user);

      await user.upload(fileInput(), file);
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(jobCalls(api)).toEqual([]);
    });
  });

  describe('what the server says', () => {
    it('says the limit of postings is reached, and keeps what was typed', async () => {
      setup({
        'POST /api/career/jobs': jsonResponse(409, {
          error: {
            code: 'job_limit',
            message: 'You can keep up to 10 job postings. Delete one to add another.',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), posting());
      await user.type(titleInput(), 'Platform Engineer');

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('up to 10 job postings');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(titleInput()).toHaveValue('Platform Engineer');
      expect(submit()).toBeEnabled();
    });

    it('says the server is not responding on a failure that is not the user’s', async () => {
      setup({ 'POST /api/career/jobs': jsonResponse(503, {}) });
      const user = userEvent.setup();
      await openDialog(user);
      await user.upload(fileInput(), posting());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('The server is not responding');
    });
  });
});
