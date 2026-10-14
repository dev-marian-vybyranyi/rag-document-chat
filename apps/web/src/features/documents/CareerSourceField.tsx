import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { validateCareerFile, validateCareerText } from './validation';

type Mode = 'file' | 'text';

interface Limits {
  what: string;
  maxBytes: number;
  maxCharacters: number;
  label: string;
}

interface CareerSourceFieldProps {
  limits: Limits;
  pastedName: string;
  disabled: boolean;
  onChange: (file: File | null, problem: string | null) => void;
}

export function CareerSourceField({
  limits,
  pastedName,
  disabled,
  onChange,
}: CareerSourceFieldProps) {
  const id = useId();
  const [mode, setMode] = useState<Mode>('file');
  const [text, setText] = useState('');

  function chooseMode(next: Mode) {
    if (disabled || next === mode) return;
    setMode(next);
    setText('');
    onChange(null, null);
  }

  function chooseFile(chosen: File | undefined) {
    if (!chosen) return onChange(null, null);
    const problem = validateCareerFile(chosen, limits);
    onChange(problem ? null : chosen, problem);
  }

  function changeText(next: string) {
    setText(next);
    if (next.trim().length === 0) return onChange(null, null);
    const problem = validateCareerText(next, limits);
    onChange(
      problem ? null : new File([next], `${pastedName}.txt`, { type: 'text/plain' }),
      problem,
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={`How to add the ${limits.what}`} className="flex gap-2">
        {(
          [
            ['file', 'File'],
            ['text', 'Paste text'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            variant={mode === value ? 'default' : 'outline'}
            size="sm"
            disabled={disabled}
            onClick={() => chooseMode(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      {mode === 'file' ? (
        <>
          <Label htmlFor={`${id}-file`}>{`File with the ${limits.what}`}</Label>
          <Input
            id={`${id}-file`}
            type="file"
            accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
            disabled={disabled}
            aria-describedby={`${id}-hint`}
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            PDF, TXT or Markdown, up to {limits.label}.
          </p>
        </>
      ) : (
        <>
          <Label htmlFor={`${id}-text`}>{`Text of the ${limits.what}`}</Label>
          <Textarea
            id={`${id}-text`}
            rows={8}
            className="max-h-64 overflow-y-auto"
            value={text}
            disabled={disabled}
            aria-describedby={`${id}-hint`}
            onChange={(event) => changeText(event.target.value)}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            Up to {limits.maxCharacters.toLocaleString('en-US')} characters.
          </p>
        </>
      )}
    </div>
  );
}
