import { BriefcaseBusinessIcon, Loader2Icon } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
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
import { CareerSourceField } from './CareerSourceField';
import { useDocuments } from './documents-context';
import { failureMessage } from './failure-message';
import {
  JOB_LIMIT_LABEL,
  MAX_COMPANY_LENGTH,
  MAX_JOB_BYTES,
  MAX_JOB_CHARACTERS,
  MAX_JOB_TITLE_LENGTH,
} from './validation';

const LIMITS = {
  what: 'job posting',
  maxBytes: MAX_JOB_BYTES,
  maxCharacters: MAX_JOB_CHARACTERS,
  label: JOB_LIMIT_LABEL,
};

export function AddJobDialog() {
  const { addJob } = useDocuments();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fieldKey, setFieldKey] = useState(0);
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setFieldKey((key) => key + 1);
    setTitle('');
    setCompany('');
    setProblem(null);
  }

  function handleOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) reset();
  }

  const changeSource = useCallback((chosen: File | null, invalid: string | null) => {
    setFile(chosen);
    setProblem(invalid);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setProblem(problem ?? 'Choose a file or paste the text of the job posting.');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      await addJob(file, { title: title.trim(), company: company.trim() });
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
          <BriefcaseBusinessIcon aria-hidden />
          Add a job posting
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-job-description">
        <DialogHeader>
          <DialogTitle>Add a job posting</DialogTitle>
          <DialogDescription id="add-job-description">
            Each posting gets a number, like Job #2, that you can use in your questions. Up to 10
            postings.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <CareerSourceField
            key={fieldKey}
            limits={LIMITS}
            pastedName="Job posting"
            disabled={pending}
            onChange={changeSource}
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor="job-title">Job title (optional)</Label>
            <Input
              id="job-title"
              autoComplete="off"
              maxLength={MAX_JOB_TITLE_LENGTH}
              placeholder="Defaults to the file name"
              value={title}
              disabled={pending}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="job-company">Company (optional)</Label>
            <Input
              id="job-company"
              autoComplete="off"
              maxLength={MAX_COMPANY_LENGTH}
              value={company}
              disabled={pending}
              onChange={(event) => setCompany(event.target.value)}
            />
          </div>

          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}

          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Loader2Icon className="animate-spin" aria-hidden />}
            {pending ? 'Adding…' : 'Add job posting'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
