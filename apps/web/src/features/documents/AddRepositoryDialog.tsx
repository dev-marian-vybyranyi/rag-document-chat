import { FolderGit2Icon, Loader2Icon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
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
import {
  MAX_ARCHIVE_BYTES,
  formatBytes,
  validateArchive,
  validateGithubAddress,
} from './validation';

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) {
      return `The archive is too large (limit ${formatBytes(MAX_ARCHIVE_BYTES)}).`;
    }
    if (error.isUnavailable) return 'The server is not responding. Try again in a moment.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

export function AddRepositoryDialog() {
  const { addRepositoryUrl, addRepositoryZip } = useDocuments();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const archiveInput = useRef<HTMLInputElement>(null);

  function handleOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setAddress('');
      setProblem(null);
    }
  }

  async function run(action: () => Promise<void>) {
    setPending(true);
    setProblem(null);
    try {
      await action();
      setOpen(false);
      setAddress('');
    } catch (error) {
      setProblem(failureMessage(error));
    } finally {
      setPending(false);
    }
  }

  function submitAddress(event: FormEvent) {
    event.preventDefault();
    const invalid = validateGithubAddress(address);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    void run(() => addRepositoryUrl(address.trim()));
  }

  function chooseArchive(file: File | undefined) {
    if (!file) return;
    const invalid = validateArchive(file);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    void run(() => addRepositoryZip(file));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderGit2Icon aria-hidden />
          Add a code repository
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-repository-description">
        <DialogHeader>
          <DialogTitle>Add a code repository</DialogTitle>
          <DialogDescription id="add-repository-description">
            Ask questions about how a project works. Files such as .env and private keys are never
            read.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submitAddress} className="flex flex-col gap-2" noValidate>
          <Label htmlFor="repository-address">GitHub address</Label>
          <Input
            id="repository-address"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repo"
            value={address}
            disabled={pending}
            aria-invalid={problem !== null}
            aria-describedby="repository-address-hint"
            onChange={(event) => {
              setAddress(event.target.value);
              setProblem(null);
            }}
          />
          <p id="repository-address-hint" className="text-xs text-muted-foreground">
            A public repository. Add /tree/branch-name to use a branch or tag other than the
            default.
          </p>
          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Loader2Icon className="animate-spin" aria-hidden />}
            {pending ? 'Importing…' : 'Import'}
          </Button>
        </form>

        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm">Upload your code as a zip archive</p>
          <Button
            variant="outline"
            className="self-start"
            disabled={pending}
            onClick={() => archiveInput.current?.click()}
          >
            Choose a zip archive
          </Button>
          <input
            ref={archiveInput}
            type="file"
            hidden
            accept=".zip,application/zip"
            aria-label="Choose a zip archive"
            onChange={(event) => {
              chooseArchive(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <p className="text-xs text-muted-foreground">Up to {formatBytes(MAX_ARCHIVE_BYTES)}.</p>
        </div>

        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
