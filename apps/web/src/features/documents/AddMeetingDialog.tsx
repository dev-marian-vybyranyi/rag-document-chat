import { CalendarClockIcon, Loader2Icon } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDocuments } from './documents-context';
import { failureMessage } from './failure-message';
import { RecordingField } from './RecordingField';
import { MAX_MEETING_TITLE_LENGTH, TRANSCRIPT_LIMIT_LABEL, validateTranscript } from './validation';

type Mode = 'transcript' | 'recording';

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'transcript', label: 'Transcript' },
  { value: 'recording', label: 'Recording' },
];

export function AddMeetingDialog() {
  const { addMeeting, addRecording } = useDocuments();
  const [mode, setMode] = useState<Mode>('transcript');
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [title, setTitle] = useState('');
  const [heldOn, setHeldOn] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function reset() {
    setMode('transcript');
    setFile(null);
    setFileKey((key) => key + 1);
    setTitle('');
    setHeldOn('');
    setProblem(null);
  }

  function handleOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) reset();
  }

  function chooseMode(next: Mode) {
    if (pending || next === mode) return;
    setMode(next);
    setFile(null);
    setFileKey((key) => key + 1);
    setProblem(null);
  }

  const changeRecording = useCallback((chosen: File | null, invalid: string | null) => {
    setFile(chosen);
    setProblem(invalid);
  }, []);

  function chooseFile(chosen: File | undefined) {
    if (!chosen) {
      setFile(null);
      setProblem(null);
      return;
    }
    const invalid = validateTranscript(chosen);
    setFile(invalid ? null : chosen);
    setProblem(invalid);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setProblem(
        problem ??
          (mode === 'recording' ? 'Choose or record a recording.' : 'Choose a transcript file.'),
      );
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const details = { title: title.trim(), heldOn };
      await (mode === 'recording' ? addRecording(file, details) : addMeeting(file, details));
      setOpen(false);
      reset();
    } catch (error) {
      setProblem(failureMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <CalendarClockIcon aria-hidden />
          Add a meeting
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-meeting-description">
        <DialogHeader>
          <DialogTitle>Add a meeting</DialogTitle>
          <DialogDescription id="add-meeting-description">
            Ask about decisions, action items and who said what.{' '}
            {mode === 'transcript'
              ? 'The transcript needs a speaker and a time on each turn, like [00:01:05] Alice: Hello. A .txt or .vtt (WebVTT) file.'
              : 'Upload a recording or record one, and it is transcribed first.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <SegmentedControl
            label="What to add"
            value={mode}
            options={MODES}
            onChange={chooseMode}
            disabled={pending}
          />

          {mode === 'recording' ? (
            <RecordingField disabled={pending} onChange={changeRecording} />
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="meeting-file">Transcript file</Label>
              <Input
                key={fileKey}
                id="meeting-file"
                type="file"
                accept=".txt,.vtt,text/plain,text/vtt"
                disabled={pending}
                aria-describedby="meeting-file-hint"
                onChange={(event) => chooseFile(event.target.files?.[0])}
              />
              <p id="meeting-file-hint" className="text-xs text-muted-foreground">
                Up to {TRANSCRIPT_LIMIT_LABEL}.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="meeting-title">Title (optional)</Label>
            <Input
              id="meeting-title"
              autoComplete="off"
              maxLength={MAX_MEETING_TITLE_LENGTH}
              placeholder="Defaults to the file name"
              value={title}
              disabled={pending}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="meeting-date">Date (optional)</Label>
            <Input
              id="meeting-date"
              type="date"
              value={heldOn}
              disabled={pending}
              className="w-auto self-start"
              onChange={(event) => setHeldOn(event.target.value)}
            />
          </div>

          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}

          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Loader2Icon className="animate-spin" aria-hidden />}
            {pending ? 'Adding…' : 'Add meeting'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
