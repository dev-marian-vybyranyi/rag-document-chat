import { CheckIcon, MinusIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStartChat } from '../chats/useStartChat';
import { describeFit } from '../documents/career-status';
import type { CareerOverview, Posting, RequirementStatus } from './api';
import {
  askAboutJob,
  IMPORTANCE_LABEL,
  orderRequirements,
  postingTitle,
  STATUS_LABEL,
} from './career-view';
import { FitMeter } from './FitMeter';

const STATUS_ICON: Record<RequirementStatus, typeof CheckIcon> = {
  met: CheckIcon,
  partial: MinusIcon,
  not_shown: XIcon,
};

export function PostingDetail({
  posting,
  resume,
}: {
  posting: Posting;
  resume: CareerOverview['resume'];
}) {
  const { start, failed } = useStartChat();
  const title = postingTitle(posting);
  const sourceIds = resume ? [resume.id, posting.id] : [posting.id];
  const fit = posting.fit;

  return (
    <section aria-label={`Details of ${title}`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{title}</h3>
          {fit && <p className="mt-1 text-sm text-muted-foreground">{describeFit(fit)}</p>}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={posting.status !== 'ready'}
          onClick={() => void start(askAboutJob(posting), sourceIds)}
        >
          Ask about this job
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Could not start a chat. Try again.
        </p>
      )}

      {fit ? (
        <>
          <FitMeter fit={fit} label={`Fit of the resume with ${title}`} />
          <div
            role="region"
            aria-label={`Requirements of ${title}`}
            tabIndex={0}
            className="overflow-x-auto rounded-lg border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Requirements of {title} and what the resume shows
              </caption>
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Requirement
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Importance
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    In the resume
                  </th>
                </tr>
              </thead>
              <tbody>
                {orderRequirements(fit.requirements).map((requirement) => {
                  const Icon = STATUS_ICON[requirement.status];
                  return (
                    <tr key={requirement.requirementId} className="border-t align-top">
                      <th scope="row" className="px-3 py-2 font-normal">
                        {requirement.text}
                      </th>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {IMPORTANCE_LABEL[requirement.importance]}
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5 font-medium">
                          <Icon className="size-3.5 shrink-0" aria-hidden />
                          {STATUS_LABEL[requirement.status]}
                        </span>
                        {requirement.quote && (
                          <blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">
                            {requirement.quote}
                          </blockquote>
                        )}
                        {requirement.note && (
                          <p className="mt-1 text-xs text-muted-foreground">{requirement.note}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            “Not shown” means the resume does not mention it. You may have the skill and not have
            written it down.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          There is no comparison with your resume yet.
        </p>
      )}
    </section>
  );
}
