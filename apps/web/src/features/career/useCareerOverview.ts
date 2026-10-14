import { useCallback, useEffect, useMemo, useState } from 'react';
import { pollDelay } from '../documents/polling';
import { careerApi, type CareerOverview } from './api';
import { pendingIds } from './career-view';

export const MAX_OVERVIEW_POLLS = 30;

export type OverviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; overview: CareerOverview; waiting: boolean };

export function useCareerOverview() {
  const [loaded, setLoaded] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; overview: CareerOverview }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [exhaustedKey, setExhaustedKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    careerApi
      .overview(controller.signal)
      .then((overview) => setLoaded({ status: 'ready', overview }))
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ status: 'error' });
      });
    return () => controller.abort();
  }, [attempt]);

  const overview = loaded.status === 'ready' ? loaded.overview : null;
  const key = useMemo(() => (overview ? pendingIds(overview).join(',') : ''), [overview]);

  useEffect(() => {
    if (key === '') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;

    const poll = async () => {
      try {
        const fresh = await careerApi.overview(controller.signal);
        setLoaded({ status: 'ready', overview: fresh });
      } catch {
        if (controller.signal.aborted) return;
      }
      polls++;
      if (polls >= MAX_OVERVIEW_POLLS) {
        setExhaustedKey(key);
        return;
      }
      timer = setTimeout(poll, pollDelay(polls));
    };

    timer = setTimeout(poll, pollDelay(0));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);

  const reload = useCallback(() => {
    setLoaded({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const state: OverviewState =
    loaded.status === 'ready' ? { ...loaded, waiting: key !== '' && exhaustedKey !== key } : loaded;
  return { state, reload };
}
