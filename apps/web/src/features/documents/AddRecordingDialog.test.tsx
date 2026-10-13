import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';
import { MAX_RECORDING_BYTES } from './validation';

const ada = { id: 'u1', email: 'ada@example.com' };

function meeting(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'm1',
    kind: 'transcript',
    filename: 'standup',
    mimeType: 'audio/mpeg',
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
    participants: null,
    durationMs: null,
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

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = vi.fn((type: string) => type === 'audio/webm;codecs=opus');
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly stream: MediaStream,
    readonly options: { mimeType: string },
  ) {
    FakeRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.onstop?.();
  }

  emit(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
}

const track = () => ({ stop: vi.fn() });
let tracks: Array<ReturnType<typeof track>> = [];
const getUserMedia = vi.fn();

function allowMicrophone() {
  getUserMedia.mockImplementation(async () => {
    tracks = [track()];
    return { getTracks: () => tracks } as unknown as MediaStream;
  });
}

function stubMicrophone() {
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  allowMicrophone();
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Add a meeting' }));
  return screen.findByRole('dialog', { name: 'Add a meeting' });
};

const chooseRecordingMode = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('radio', { name: 'Recording' }));
};

const recordingInput = () => screen.getByLabelText('Recording file') as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: 'Add meeting' });
const audioCalls = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'POST /api/meetings/audio');
const recorder = () => FakeRecorder.instances.at(-1)!;

function audioFile(name = 'standup.mp3', size = 100, type = 'audio/mpeg') {
  return new File([new Uint8Array(size).fill(1)], name, { type });
}

beforeEach(() => {
  FakeRecorder.instances = [];
  getUserMedia.mockReset();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('adding a recording of a meeting', () => {
  describe('choosing what to add', () => {
    it('starts with the transcript, and switches to the recording and back', async () => {
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);

      expect(screen.getByRole('radio', { name: 'Transcript' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByLabelText('Transcript file')).toBeInTheDocument();
      expect(screen.queryByLabelText('Recording file')).not.toBeInTheDocument();

      await chooseRecordingMode(user);

      expect(screen.getByRole('radio', { name: 'Recording' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(recordingInput()).toHaveAttribute('accept', expect.stringContaining('.webm'));
      expect(screen.queryByLabelText('Transcript file')).not.toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: 'Transcript' }));

      expect(screen.getByLabelText('Transcript file')).toBeInTheDocument();
    });

    it('says what happens to a recording and how far to trust the result', async () => {
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);

      await chooseRecordingMode(user);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('up to 15 MB');
      expect(dialog).toHaveTextContent('thrown away');
      expect(dialog).toHaveTextContent('times are estimates');
    });

    it('forgets the chosen file when the kind is changed', async () => {
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.upload(recordingInput(), audioFile());

      await user.click(screen.getByRole('radio', { name: 'Transcript' }));
      await chooseRecordingMode(user);

      expect(recordingInput().files).toHaveLength(0);
    });
  });

  describe('sending a file', () => {
    it('sends it to the recording endpoint with the title and date, then lists the meeting', async () => {
      const api = setup({
        'POST /api/meetings/audio': jsonResponse(202, {
          document: meeting({ filename: 'Release sync' }),
        }),
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);

      await user.upload(recordingInput(), audioFile('call-77.mp3'));
      await user.type(screen.getByLabelText('Title (optional)'), 'Release sync');
      fireEvent.change(screen.getByLabelText('Date (optional)'), {
        target: { value: '2026-10-01' },
      });
      await user.click(submit());

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const [call] = audioCalls(api);
      expect(call?.form?.get('title')).toBe('Release sync');
      expect(call?.form?.get('heldOn')).toBe('2026-10-01');
      expect((call?.form?.get('file') as File).name).toBe('call-77.mp3');
      expect(api.calls.some((c) => c.route === 'POST /api/meetings')).toBe(false);
      const list = await screen.findByRole('list', { name: 'Documents' });
      expect(within(list).getByText('Release sync')).toBeInTheDocument();
    });

    it('shows the phase of a recording that is being transcribed', async () => {
      setup({
        'GET /api/documents': jsonResponse(200, {
          documents: [meeting({ progress: { phase: 'transcribing', done: 0, total: 0 } })],
        }),
      });

      expect(await screen.findByText('Transcribing the recording…')).toBeInTheDocument();
    });

    it('shows a card for a recording whose speakers and length are not known yet', async () => {
      setup({ 'GET /api/documents': jsonResponse(200, { documents: [meeting()] }) });

      const list = await screen.findByRole('list', { name: 'Documents' });

      expect(within(list).getByText('standup')).toBeInTheDocument();
      expect(list).not.toHaveTextContent('speakers');
    });

    it('shows what the server says when it is busy and lets the same file be sent again', async () => {
      let attempts = 0;
      const api = setup({
        'POST /api/meetings/audio': () => {
          attempts += 1;
          return attempts === 1
            ? jsonResponse(503, {
                error: {
                  code: 'ai_busy',
                  message: 'Other recordings are being transcribed. Try again in a few minutes.',
                },
              })
            : jsonResponse(202, { document: meeting() });
        },
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.upload(recordingInput(), audioFile());

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Other recordings are being transcribed. Try again in a few minutes.',
      );
      await user.click(submit());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(audioCalls(api)).toHaveLength(2);
    });
  });

  describe('what it refuses before asking the server', () => {
    it('asks for a recording when none is chosen', async () => {
      const api = setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);

      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent('Choose or record a recording.');
      expect(audioCalls(api)).toHaveLength(0);
    });

    it.each([
      ['a transcript', audioFile('notes.txt', 10, 'text/plain'), /\.mp3, \.wav, \.m4a or \.webm/],
      ['an empty file', audioFile('a.mp3', 0), /empty/],
    ])('refuses %s', async (_label, file, message) => {
      const api = setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, applyAccept: false });
      await openDialog(user);
      await chooseRecordingMode(user);

      await user.upload(recordingInput(), file);
      await user.click(submit());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(audioCalls(api)).toHaveLength(0);
    });

    it('refuses a file over the limit and says what the limit is', async () => {
      const api = setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      const large = audioFile('long.mp3', 10);
      Object.defineProperty(large, 'size', { value: MAX_RECORDING_BYTES + 1 });

      await user.upload(recordingInput(), large);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The file is too large (limit 15 MB).',
      );
      await user.click(submit());
      expect(audioCalls(api)).toHaveLength(0);
    });

    it('takes the message away once a good file is chosen', async () => {
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, applyAccept: false });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.upload(recordingInput(), audioFile('x.txt', 5, 'text/plain'));
      expect(await screen.findByRole('alert')).toBeInTheDocument();

      await user.upload(recordingInput(), audioFile());

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('recording from the microphone', () => {
    it('says so when the browser cannot record, and keeps the file input', async () => {
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);

      await chooseRecordingMode(user);

      expect(
        screen.queryByRole('button', { name: 'Record from the microphone' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('dialog')).toHaveTextContent('cannot record from the microphone');
      expect(recordingInput()).toBeInTheDocument();
    });

    it('records, counts the seconds, stops, and sends the recording as a webm file', async () => {
      stubMicrophone();
      const api = setup({
        'POST /api/meetings/audio': jsonResponse(202, { document: meeting() }),
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);

      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));

      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(await screen.findByRole('button', { name: 'Stop recording' })).toBeInTheDocument();
      expect(recorder().options.mimeType).toBe('audio/webm;codecs=opus');
      expect(screen.getByRole('timer')).toHaveTextContent('00:00:00');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByRole('timer')).toHaveTextContent('00:00:03');

      act(() => recorder().emit(2048));
      await user.click(screen.getByRole('button', { name: 'Stop recording' }));

      expect(await screen.findByText(/Recorded 00:00:03 · 2 KB/)).toBeInTheDocument();
      expect(tracks[0]!.stop).toHaveBeenCalled();
      await user.click(submit());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const file = audioCalls(api)[0]!.form!.get('file') as File;
      expect(file.name).toMatch(/^recording-\d{4}-\d{2}-\d{2}\.webm$/);
      expect(file.type).toBe('audio/webm');
      expect(file.size).toBe(2048);
    });

    it('stops counting when the recording stops', async () => {
      stubMicrophone();
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      act(() => {
        vi.advanceTimersByTime(2000);
        recorder().emit(10);
      });
      await user.click(await screen.findByRole('button', { name: 'Stop recording' }));

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.getByText(/Recorded 00:00:02/)).toBeInTheDocument();
    });

    it('lets the recording be discarded and made again', async () => {
      stubMicrophone();
      const api = setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      act(() => recorder().emit(100));
      await user.click(await screen.findByRole('button', { name: 'Stop recording' }));
      await user.click(await screen.findByRole('button', { name: 'Discard' }));

      expect(screen.getByRole('button', { name: 'Record from the microphone' })).toBeEnabled();
      await user.click(submit());
      expect(await screen.findByRole('alert')).toHaveTextContent('Choose or record a recording.');
      expect(audioCalls(api)).toHaveLength(0);
    });

    it('drops the recording when a file is chosen instead', async () => {
      stubMicrophone();
      const api = setup({
        'POST /api/meetings/audio': jsonResponse(202, { document: meeting() }),
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      act(() => recorder().emit(100));
      await user.click(await screen.findByRole('button', { name: 'Stop recording' }));
      await screen.findByText(/Recorded/);

      await user.upload(recordingInput(), audioFile('upload.mp3'));

      expect(screen.queryByText(/Recorded/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Record from the microphone' })).toBeEnabled();
      await user.click(submit());
      await waitFor(() => expect(audioCalls(api)).toHaveLength(1));
      expect((audioCalls(api)[0]!.form!.get('file') as File).name).toBe('upload.mp3');
    });

    it('disables the file input and the submit button while recording', async () => {
      stubMicrophone();
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);

      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      await screen.findByRole('button', { name: 'Stop recording' });

      expect(recordingInput()).toBeDisabled();
    });

    it('says when the microphone is blocked, and when there is none', async () => {
      stubMicrophone();
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      getUserMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));

      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('The microphone is blocked');
      expect(FakeRecorder.instances).toHaveLength(0);

      getUserMedia.mockRejectedValueOnce(new DOMException('none', 'NotFoundError'));
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('No microphone was found');
    });

    it('says when nothing was recorded', async () => {
      stubMicrophone();
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));

      await user.click(await screen.findByRole('button', { name: 'Stop recording' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was recorded');
      expect(tracks[0]!.stop).toHaveBeenCalled();
    });

    it('stops by itself at the size limit and keeps what was recorded', async () => {
      stubMicrophone();
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      await screen.findByRole('button', { name: 'Stop recording' });

      act(() => recorder().emit(MAX_RECORDING_BYTES - 600 * 1024));
      expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument();
      act(() => recorder().emit(200 * 1024));

      expect(await screen.findByText(/Recorded/)).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('stopped at the size limit');
      expect(tracks[0]!.stop).toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('lets go of the microphone when the dialog is closed during a recording, and keeps nothing', async () => {
      stubMicrophone();
      const api = setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      await screen.findByRole('button', { name: 'Stop recording' });
      act(() => recorder().emit(100));

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(tracks[0]!.stop).toHaveBeenCalled();
      expect(recorder().state).toBe('inactive');
      expect(audioCalls(api)).toHaveLength(0);
    });

    it('lets go of the microphone when the kind is changed during a recording', async () => {
      stubMicrophone();
      setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      await screen.findByRole('button', { name: 'Stop recording' });

      await user.click(screen.getByRole('radio', { name: 'Transcript' }));

      expect(tracks[0]!.stop).toHaveBeenCalled();
      expect(screen.getByLabelText('Transcript file')).toBeInTheDocument();
    });

    it('records as mp4 where the browser has nothing else, and names the file .m4a', async () => {
      stubMicrophone();
      FakeRecorder.isTypeSupported.mockImplementation((type: string) => type === 'audio/mp4');
      const api = setup({
        'POST /api/meetings/audio': jsonResponse(202, { document: meeting() }),
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openDialog(user);
      await chooseRecordingMode(user);
      await user.click(screen.getByRole('button', { name: 'Record from the microphone' }));
      act(() => recorder().emit(300));
      await user.click(await screen.findByRole('button', { name: 'Stop recording' }));
      await screen.findByText(/Recorded/);

      await user.click(submit());

      await waitFor(() => expect(audioCalls(api)).toHaveLength(1));
      const file = audioCalls(api)[0]!.form!.get('file') as File;
      expect(file.name).toMatch(/\.m4a$/);
      expect(file.type).toBe('audio/mp4');
      FakeRecorder.isTypeSupported.mockImplementation(
        (type: string) => type === 'audio/webm;codecs=opus',
      );
    });
  });
});
