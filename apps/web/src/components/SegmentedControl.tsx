import { useRef, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  size?: 'xs' | 'sm';
  disabled?: boolean;
  className?: string;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'sm',
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent, index: number) {
    let next: number | undefined;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (event.key in STEP) next = (index + STEP[event.key]! + options.length) % options.length;
    if (next === undefined) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    onChange(options[next]!.value);
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn('flex gap-2', className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <Button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            variant={checked ? 'default' : 'outline'}
            size={size}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
