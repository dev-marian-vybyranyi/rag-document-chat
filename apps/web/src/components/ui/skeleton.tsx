import * as React from 'react';
import { cn } from 'cn';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('animate-pulse rounded-lg bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
