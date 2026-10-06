export function createJobQueue(concurrency: number, onError: (error: unknown) => void) {
  const waiting: Array<() => Promise<void>> = [];
  let running = 0;
  let idleWaiters: Array<() => void> = [];

  const settleIfIdle = () => {
    if (running > 0 || waiting.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const startNext = () => {
    while (running < concurrency && waiting.length > 0) {
      const job = waiting.shift()!;
      running++;
      job()
        .catch(onError)
        .finally(() => {
          running--;
          startNext();
          settleIfIdle();
        });
    }
  };

  return {
    add(job: () => Promise<void>) {
      waiting.push(job);
      startNext();
    },
    idle(): Promise<void> {
      if (running === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
