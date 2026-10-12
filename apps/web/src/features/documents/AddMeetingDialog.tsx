import { CalendarClockIcon, Loader2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
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
import { ApiError } from '../../lib/api';
import { useDocuments } from './documents-context';
import { MAX_MEETING_TITLE_LENGTH, TRANSCRIPT_LIMIT_LABEL, validateTranscript } from './validation';

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isUnavailable) return 'The server is not responding. Try again in a moment.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

export function AddMeetingDialog() {
  const { addMeeting } = useDocuments();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [title, setTitle] = useState('');
  const [heldOn, setHeldOn] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function reset() {
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
      setProblem(problem ?? 'Choose a transcript file.');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      await addMeeting(file, { title: title.trim(), heldOn });
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
            Ask about decisions, action items and who said what. The transcript needs a speaker and
            a time on each turn, like [00:01:05] Alice: Hello. A .txt or .vtt (WebVTT) file.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
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
