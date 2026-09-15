/**
 * The worker loop.
 *
 * Two responsibilities, deliberately separated:
 *
 * * `observe` — read the chain and schedule the next action per auction. Cheap, runs
 *   on a fixed interval, and is where "what does this auction need next?" lives.
 * * `advance` — execute one job under a lease. Expensive, and safe to run from many
 *   processes because the queue guarantees one live job per `(auction, kind)`.
 *
 * A worker that ticks every few seconds and does nothing is the normal case. The loop
 * is written so that a stuck job degrades into a logged abandonment rather than a fee
 * being burned on every tick forever.
 */

import type { App } from './app.ts';
import { childLogger } from './logger.ts';
import type { JobRecord } from './store/types.ts';
import type { AdvanceResult } from './services/orchestrator.ts';

export interface WorkerOptions {
  /** Milliseconds between observe ticks. */
  readonly observeIntervalMs?: number;
  /** How many jobs to claim per tick. */
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

export interface WorkerHandle {
  readonly stop: () => Promise<void>;
  /** Run exactly one observe + drain cycle. Used by tests and the admin endpoint. */
  readonly tick: () => Promise<TickSummary>;
}

export interface TickSummary {
  readonly observed: number;
  readonly scheduled: number;
  readonly claimed: number;
  readonly results: readonly AdvanceResult[];
}

export function startWorker(app: App, options: WorkerOptions = {}): WorkerHandle {
  const log = childLogger('worker');
  const observeIntervalMs = options.observeIntervalMs ?? app.config.WORKER_INTERVAL_MS;
  const batchSize = options.batchSize ?? 5;

  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  options.signal?.addEventListener('abort', () => abort.abort(), { once: true });

  const tick = async (): Promise<TickSummary> => {
    if (running) return { observed: 0, scheduled: 0, claimed: 0, results: [] };
    running = true;

    let observed = 0;
    let scheduled = 0;
    const results: AdvanceResult[] = [];

    try {
      const summary = await app.orchestrator.observe();
      observed = Number(summary.scanned);
      scheduled = summary.scheduled.length;

      const jobs = await app.store.claimJobs(
        ['attest', 'reveal', 'settle'],
        batchSize,
        app.config.JOB_LEASE_MS,
      );

      for (const job of jobs) {
        if (abort.signal.aborted) break;
        results.push(await runJob(app, job));
      }
    } catch (error) {
      log.error({ err: describe(error) }, 'worker tick failed');
    } finally {
      running = false;
    }

    return { observed, scheduled, claimed: results.length, results };
  };

  const loop = async (): Promise<void> => {
    while (!stopped && !abort.signal.aborted) {
      const summary = await tick();
      if (summary.claimed > 0) {
        log.debug({ tick: summary }, 'worker tick');
      }
      await sleep(observeIntervalMs);
    }
  };

  void loop();

  return {
    tick,
    stop: async () => {
      stopped = true;
      abort.abort();
      if (timer) clearTimeout(timer);
      // Let an in-flight tick finish so we do not abandon a leased job mid-flight.
      while (running) await sleep(100);
    },
  };
}

async function runJob(app: App, job: JobRecord): Promise<AdvanceResult> {
  const log = childLogger('worker', { jobId: job.id, auctionId: job.auctionId, kind: job.kind });

  if (job.attempts > app.config.JOB_MAX_ATTEMPTS) {
    log.error(
      { attempts: job.attempts, lastError: job.lastError },
      'abandoning job after exhausting its attempt budget; a human needs to look at this auction',
    );
    await app.store.abandonJob(job.id, job.lastError ?? 'attempt budget exhausted');
    return {
      status: 'failed',
      kind: job.kind,
      auctionId: job.auctionId,
      reason: 'attempt budget exhausted',
    };
  }

  const result = await app.orchestrator.advance(job);

  switch (result.status) {
    case 'done':
      await app.store.completeJob(job.id);
      return result;

    case 'partial':
      // Some work landed; reschedule rather than retry immediately.
      await app.store.failJob(job.id, result.reason ?? 'partial completion', {
        retryAfterMs: result.retryInMs ?? 15_000,
      });
      return result;

    case 'deferred':
      // Not an error: the auction simply is not ready. Re-schedule without counting
      // it against the attempt budget by resetting the lease.
      await app.store.failJob(job.id, result.reason ?? 'deferred', {
        retryAfterMs: result.retryInMs ?? 10_000,
      });
      log.debug({ reason: result.reason, retryInMs: result.retryInMs }, 'deferred');
      return result;

    case 'skipped':
      await app.store.completeJob(job.id);
      log.debug({ reason: result.reason }, 'nothing to do');
      return result;

    case 'failed':
    default:
      await app.store.failJob(job.id, result.reason ?? 'unknown failure', { retryAfterMs: 30_000 });
      log.warn({ reason: result.reason, details: result.details }, 'job failed');
      return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
