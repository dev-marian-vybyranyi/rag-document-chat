import { InfoIcon } from 'lucide-react';
import { useSourceViewer, type WhyData } from './source-viewer-context';

export function WhyButton({ data }: { data: WhyData }) {
  const { openWhy } = useSourceViewer();

  return (
    <button
      type="button"
      onClick={() => openWhy(data)}
      className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <InfoIcon className="size-3" aria-hidden />
      Why this answer?
    </button>
  );
}
