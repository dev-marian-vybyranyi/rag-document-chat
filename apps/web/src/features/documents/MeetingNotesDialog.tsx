import { ClipboardCopyIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ApiError } from '../../lib/api';
import type { DocumentItem, MeetingNotes } from './api';
import { useDocuments } from './documents-context';
import { describeNotesCounts, formatClock, notesToMarkdown } from './meeting-status';

function regenerateMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ai_busy') return error.message;
    if (error.isUnavailable) return 'The server is not responding. Try again in a moment.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Time({ ms }: { ms: number }) {
  return <span className="font-mono text-xs text-muted-foreground">{formatClock(ms)}</span>;
}

function Notes({ notes }: { notes: MeetingNotes }) {
  const empty =
    notes.summary === '' &&
    notes.topics.length === 0 &&
    notes.decisions.length === 0 &&
    notes.actionItems.length === 0 &&
    notes.openQuestions.length === 0;
  if (empty) {
    return <p className="text-sm text-muted-foreground">Nothing worth noting was found.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {notes.summary && (
        <Section title="Summary">
          <p className="text-sm">{notes.summary}</p>
        </Section>
      )}
      {notes.topics.length > 0 && (
        <Section title="Topics">
          <ul className="flex flex-wrap gap-1.5" aria-label="Topics">
            {notes.topics.map((topic) => (
              <li key={topic} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {topic}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {notes.decisions.length > 0 && (
        <Section title="Decisions">
          <ul className="flex flex-col gap-1.5 text-sm" aria-label="Decisions">
            {notes.decisions.map((decision) => (
              <li key={`${decision.startMs}-${decision.text}`} className="flex gap-2">
                <Time ms={decision.startMs} />
                <span>{decision.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {notes.actionItems.length > 0 && (
        <Section title="Action items">
          <ul className="flex flex-col gap-2 text-sm" aria-label="Action items">
            {notes.actionItems.map((item) => (
              <li key={`${item.startMs}-${item.task}`} className="flex gap-2">
                <Time ms={item.startMs} />
                <span className="flex min-w-0 flex-col">
                  <span>{item.task}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.owner ? `Owner: ${item.owner}` : 'No owner stated'}
                    {item.due && ` · Due: ${item.due}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {notes.openQuestions.length > 0 && (
        <Section title="Open questions">
          <ul className="list-disc pl-5 text-sm" aria-label="Open questions">
            {notes.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function MeetingNotesDialog({ document }: { document: DocumentItem }) {
  const { regenerateNotes } = useDocuments();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const notes = document.notes;

  function handleOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setProblem(null);
      setCopy('idle');
    }
  }

  async function regenerate() {
    setPending(true);
    setProblem(null);
    try {
      await regenerateNotes(document.id);
    } catch (error) {
      setProblem(regenerateMessage(error));
    } finally {
      setPending(false);
    }
  }

  async function copyNotes() {
    if (!notes) return;
    try {
      await navigator.clipboard.writeText(notesToMarkdown(document, notes));
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Notes for ${document.filename}`}>
          Notes
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby="meeting-notes-description"
        className="max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{document.filename}</DialogTitle>
          <DialogDescription id="meeting-notes-description">
            {notes
              ? `${describeNotesCounts(notes)}. Written by a model from the transcript; every decision and action item was checked against what was said.`
              : 'Notes list the decisions and action items from the meeting.'}
          </DialogDescription>
        </DialogHeader>

        {notes ? (
          <Notes notes={notes} />
        ) : (
          <p className="text-sm text-muted-foreground">
            There are no notes for this meeting yet. You can still ask questions about it.
          </p>
        )}

        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void regenerate()}>
            {pending ? (
              <Loader2Icon className="animate-spin" aria-hidden />
            ) : (
              <RefreshCwIcon aria-hidden />
            )}
            {pending ? 'Writing notes…' : notes ? 'Write the notes again' : 'Generate notes'}
          </Button>
          {notes && (
            <Button variant="outline" size="sm" onClick={() => void copyNotes()}>
              <ClipboardCopyIcon aria-hidden />
              Copy as Markdown
            </Button>
          )}
          <p role="status" className="text-xs text-muted-foreground">
            {copy === 'copied' && 'Copied.'}
            {copy === 'failed' && 'Could not copy. Select the text instead.'}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
