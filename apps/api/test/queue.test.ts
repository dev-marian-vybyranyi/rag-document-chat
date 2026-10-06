import { describe, expect, it, vi } from 'vitest';
import { createJobQueue } from '../src/documents/queue.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createJobQueue', () => {
  it('runs jobs in the order they were added when one runs at a time', async () => {
    const queue = createJobQueue(1, vi.fn());
    const order: number[] = [];

    for (const n of [1, 2, 3]) {
      queue.add(async () => {
        await tick();
        order.push(n);
      });
    }
    await queue.idle();

    expect(order).toEqual([1, 2, 3]);
  });

  it('never runs more jobs at once than allowed', async () => {
    let active = 0;
    let peak = 0;
    const queue = createJobQueue(2, vi.fn());

    for (let i = 0; i < 6; i++) {
      queue.add(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      });
    }
    await queue.idle();

    expect(peak).toBe(2);
  });

  it('keeps going after a job fails and reports the failure', async () => {
    const onError = vi.fn();
    const queue = createJobQueue(1, onError);
    const ran: string[] = [];

    queue.add(async () => {
      throw new Error('boom');
    });
    queue.add(async () => {
      ran.push('second');
    });
    await queue.idle();

    expect(ran).toEqual(['second']);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'boom' });
  });

  it('is idle at once when nothing was added', async () => {
    await expect(createJobQueue(1, vi.fn()).idle()).resolves.toBeUndefined();
  });

  it('lets several callers wait for the queue to drain', async () => {
    const queue = createJobQueue(1, vi.fn());
    let finished = false;
    queue.add(async () => {
      await tick(20);
      finished = true;
    });

    await Promise.all([queue.idle(), queue.idle()]);

    expect(finished).toBe(true);
  });

  it('can be used again after it has drained', async () => {
    const queue = createJobQueue(1, vi.fn());
    const ran: number[] = [];
    queue.add(async () => void ran.push(1));
    await queue.idle();

    queue.add(async () => void ran.push(2));
    await queue.idle();

    expect(ran).toEqual([1, 2]);
  });
});
