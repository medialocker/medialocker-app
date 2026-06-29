import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { MemoryAdapter } from '@reaatech/idempotency-middleware';

/**
 * withJobIdempotency wraps a side-effecting BullMQ processor so a redelivered
 * job with the same identity does not re-apply its side effects.
 *
 * We exercise the REAL middleware (`idempotentHandler`) against an in-memory
 * storage adapter, so these assertions reflect the library's actual semantics
 * — including the worker's `shouldCache` override that caches only successful
 * results and lets failures fall through so BullMQ retries can re-run them.
 */

// ioredis must never open a socket in tests.
vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  })),
}));

vi.mock('@medialocker/config', () => ({
  getConfig: () => ({ REDIS_URL: 'redis://localhost:6379' }),
}));

// The worker builds a RedisAdapter; swap it for the real MemoryAdapter so the
// middleware's connect/lock/get/set logic runs without a Redis server.
vi.mock('@reaatech/idempotency-middleware-adapter-redis', () => ({
  RedisAdapter: vi.fn().mockImplementation(() => new MemoryAdapter()),
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { withJobIdempotency, closeIdempotency } from '../idempotency';

function job<T>(data: T, id: string): Job<T> {
  return { id, data } as unknown as Job<T>;
}

beforeEach(async () => {
  await closeIdempotency();
});

describe('withJobIdempotency', () => {
  it('runs the wrapped processor on the first invocation', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withJobIdempotency('usage', fn);

    await wrapped(job({ idempotencyKey: 'k1' }, 'j1'));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('short-circuits a redelivered job with the same key (does NOT re-run)', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withJobIdempotency('usage', fn);

    // Same domain idempotencyKey, even with a different BullMQ job id.
    await wrapped(job({ idempotencyKey: 'dup' }, 'attempt-1'));
    await wrapped(job({ idempotencyKey: 'dup' }, 'attempt-2'));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs distinct keys independently', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withJobIdempotency('usage', fn);

    await wrapped(job({ idempotencyKey: 'a' }, 'j1'));
    await wrapped(job({ idempotencyKey: 'b' }, 'j2'));

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('scopes keys by queue name so the same id across queues does not collide', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const usage = withJobIdempotency('usage', fn);
    const billing = withJobIdempotency('billing', fn);

    await usage(job({}, 'shared-id'));
    await billing(job({}, 'shared-id'));

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('falls back to the BullMQ job id when no domain key is present', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withJobIdempotency('usage', fn);

    await wrapped(job({}, 'same-job'));
    await wrapped(job({}, 'same-job'));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure: a retry with the same key RE-EXECUTES (§P1)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const wrapped = withJobIdempotency('usage', fn);

    // First attempt fails and propagates.
    await expect(wrapped(job({ idempotencyKey: 'poison' }, 'j1'))).rejects.toThrow(
      'boom',
    );

    // shouldCache excludes errors, so the failure is NOT cached: a BullMQ retry
    // with the same key actually re-runs the processor (here it now succeeds)
    // rather than replaying a poisoned cached error for the whole TTL.
    await expect(wrapped(job({ idempotencyKey: 'poison' }, 'j2'))).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('still caches a SUCCESS: a redelivery with the same key does not re-run', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withJobIdempotency('usage', fn);

    await wrapped(job({ idempotencyKey: 'ok' }, 'j1'));
    await wrapped(job({ idempotencyKey: 'ok' }, 'j2'));

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
