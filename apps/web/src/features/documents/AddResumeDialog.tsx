import { FileUserIcon, Loader2Icon } from 'lucide-react';
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
import { CareerSourceField } from './CareerSourceField';
import { useDocuments } from './documents-context';
import { failureMessage } from './failure-message';
import { MAX_RESUME_BYTES, MAX_RESUME_CHARACTERS, RESUME_LIMIT_LABEL } from './validation';

const LIMITS = {
  what: 'resume',
  maxBytes: MAX_RESUME_BYTES,
  maxCharacters: MAX_RESUME_CHARACTERS,
  label: RESUME_LIMIT_LABEL,
};

export function AddResumeDialog({ hasResume = false }: { hasResume?: boolean }) {
  const { addResume } = useDocuments();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fieldKey, setFieldKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setFieldKey((key) => key + 1);
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
      setProblem(problem ?? 'Choose a file or paste the text of your resume.');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      await addResume(file);
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
        <Button
          variant="outline"
          disabled={hasResume}
          title={hasResume ? 'Delete your resume to add a different one' : undefined}
        >
          <FileUserIcon aria-hidden />
          Add a resume
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-resume-description">
        <DialogHeader>
          <DialogTitle>Add your resume</DialogTitle>
          <DialogDescription id="add-resume-description">
            Compare it with job postings and ask what you are missing. One resume at a time. Email
            addresses, links, phone numbers and street addresses are removed before the text is
            analysed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <CareerSourceField
            key={fieldKey}
            limits={LIMITS}
            pastedName="Resume"
            disabled={pending}
            onChange={changeSource}
          />

          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}

          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Loader2Icon className="animate-spin" aria-hidden />}
            {pending ? 'Adding…' : 'Add resume'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
