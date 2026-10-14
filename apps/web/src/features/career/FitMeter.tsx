import type { Fit } from './api';
import { describeFit } from '../documents/career-status';

export function FitMeter({ fit, label }: { fit: Fit; label: string }) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fit.coverage}
      aria-valuetext={describeFit(fit)}
      className="relative h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-primary"
        style={{ width: `${fit.coverage}%` }}
      />
    </div>
  );
}
