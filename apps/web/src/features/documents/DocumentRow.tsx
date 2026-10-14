import {
  BriefcaseBusinessIcon,
  FileTextIcon,
  FileUserIcon,
  FolderGit2Icon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DocumentItem } from './api';
import { useStartChat } from '../chats/useStartChat';
import { CareerDetails } from './CareerDetails';
import { careerTitle, describeCareerStatus, isCareer } from './career-status';
import { useDocuments } from './documents-context';
import { suggestionsOf } from './meeting-questions';
import { MeetingNotesDialog } from './MeetingNotesDialog';
import { describeMeetingCounts, describeNotesCounts, shownSpeakers } from './meeting-status';
import {
  commitUrl,
  describeProgress,
  describeRepositoryCounts,
  progressFraction,
  safeGithubUrl,
  shortSha,
} from './repository-status';
import { formatBytes } from './validation';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function describeStatus(document: DocumentItem): string {
  if (isCareer(document)) return describeCareerStatus(document);
  if (document.kind === 'repository') return describeRepositoryStatus(document);
  if (document.kind === 'transcript') return describeMeetingStatus(document);
  if (document.status === 'processing') return 'Processing…';
  if (document.status === 'failed') return 'Failed';
  const parts = ['Ready'];
  if (document.pageCount !== null) parts.push(plural(document.pageCount, 'page'));
  parts.push(plural(document.chunkCount, 'passage'));
  return parts.join(' · ');
}

function describeMeetingStatus(document: DocumentItem): string {
  if (document.status === 'processing') return describeProgress(document.progress);
  if (document.status === 'failed') return 'Failed';
  const counts = describeMeetingCounts(document);
  return document.notes ? `${counts} · ${describeNotesCounts(document.notes)}` : counts;
}

function describeRepositoryStatus(document: DocumentItem): string {
  if (document.status === 'processing') return describeProgress(document.progress);
  if (document.status === 'failed') return 'Failed';
  return describeRepositoryCounts(document);
}

function RepositoryDetails({ document }: { document: DocumentItem }) {
  const sha = document.commitSha;
  if (document.status !== 'ready' || !sha) return null;
  const href = commitUrl(document);
  return (
    <>
      {' · '}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          commit {shortSha(sha)}
        </a>
      ) : (
        <>commit {shortSha(sha)}</>
      )}
      {document.repoRef && <> on {document.repoRef}</>}
    </>
  );
}

export function DocumentRow({ document }: { document: DocumentItem }) {
  const { remove } = useDocuments();
  const { start, failed: startFailed } = useStartChat();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function confirmRemove() {
    setPending(true);
    setFailed(false);
    try {
      await remove(document.id);
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  const isRepository = document.kind === 'repository';
  const isMeeting = document.kind === 'transcript';
  const repositoryUrl = isRepository ? safeGithubUrl(document.repoUrl) : null;
  const career = isCareer(document);
  const Icon = isRepository
    ? FolderGit2Icon
    : isMeeting
      ? UsersIcon
      : document.kind === 'resume'
        ? FileUserIcon
        : document.kind === 'job_posting'
          ? BriefcaseBusinessIcon
          : FileTextIcon;
  const name = career ? careerTitle(document) : document.filename;
  const speakers = isMeeting && document.participants ? shownSpeakers(document.participants) : null;
  const fraction = progressFraction(document.progress);
  const suggestions = suggestionsOf(document);

  return (
    <li className="flex flex-col gap-1 rounded-lg border bg-background px-4 py-3">
      <div className="flex items-center gap-3">
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={name}>
            {repositoryUrl ? (
              <a
                href={repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${document.filename} on GitHub`}
                className="underline-offset-2 hover:underline"
              >
                {document.filename}
              </a>
            ) : (
              name
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {isRepository || isMeeting || career ? (
              <>
                {describeStatus(document)}
                <RepositoryDetails document={document} />
              </>
            ) : (
              `${formatBytes(document.sizeBytes)} · ${describeStatus(document)}`
            )}
          </p>
        </div>
        {isMeeting && document.status === 'ready' && !confirming && (
          <MeetingNotesDialog document={document} />
        )}
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">Delete?</span>
            <Button variant="destructive" size="sm" onClick={confirmRemove} disabled={pending}>
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${name}`}
            onClick={() => {
              setFailed(false);
              setConfirming(true);
            }}
          >
            <Trash2Icon aria-hidden />
          </Button>
        )}
      </div>
      {document.status === 'processing' && (
        <div
          role="progressbar"
          aria-label={`Processing ${name}`}
          {...(fraction !== null && {
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(fraction * 100),
          })}
          className="relative h-1 overflow-hidden rounded-full bg-muted"
        >
          {fraction === null ? (
            <div className="absolute inset-y-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
          ) : (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${fraction * 100}%` }}
            />
          )}
        </div>
      )}
      {career && <CareerDetails document={document} />}
      {speakers && speakers.shown.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-1" aria-label={`Speakers in ${document.filename}`}>
          {speakers.shown.map((name) => (
            <li key={name} className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {name}
            </li>
          ))}
          {speakers.more > 0 && (
            <li className="px-1 py-0.5 text-xs text-muted-foreground">+{speakers.more} more</li>
          )}
        </ul>
      )}
      {document.status === 'ready' && suggestions.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5 pt-1"
          aria-label={`Questions to ask about ${document.filename}`}
        >
          {suggestions.map((question) => (
            <li key={question} className="max-w-full">
              <Button
                variant="outline"
                size="xs"
                className="h-auto max-w-full py-1 text-left whitespace-normal"
                onClick={() => void start(question, [document.id])}
              >
                {question}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {startFailed && (
        <p role="alert" className="text-sm text-destructive">
          Could not start a chat. Try again.
        </p>
      )}
      {document.status === 'failed' && document.error && (
        <p className="text-sm text-destructive">{document.error}</p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Could not delete the document. Try again.
        </p>
      )}
    </li>
  );
}
