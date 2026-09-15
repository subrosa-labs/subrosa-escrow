/**
 * Store semantics.
 *
 * These run against the in-memory driver, which implements the same lease and
 * idempotency contract as the Postgres one. The two properties worth pinning:
 *
 * * a job that is claimed twice by different workers must not be claimable twice at
 *   the same time (so two relayers cannot both pay for one reveal);
 * * an abandoned job must stay abandoned (so a permanently broken auction cannot burn
 *   a fee on every tick forever).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/memory.ts';

describe('MemoryStore jobs', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('upserts idempotently for the same (auction, kind)', async () => {
    const first = await store.upsertJob({ auctionId: '1', kind: 'reveal' });
    const second = await store.upsertJob({ auctionId: '1', kind: 'reveal' });

    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(0);
    expect(await store.listJobs('1')).toHaveLength(1);
  });

  it('pulls the schedule earlier but never pushes it later', async () => {
    const later = new Date(Date.now() + 60_000);
    await store.upsertJob({ auctionId: '1', kind: 'attest', runAfter: later });
    expect((await store.listJobs('1'))[0]!.runAfter).toBe(later.toISOString());

    const sooner = new Date(Date.now() + 1_000);
    await store.upsertJob({ auctionId: '1', kind: 'attest', runAfter: sooner });
    expect((await store.listJobs('1'))[0]!.runAfter).toBe(sooner.toISOString());

    await store.upsertJob({ auctionId: '1', kind: 'attest', runAfter: new Date(Date.now() + 900_000) });
    expect((await store.listJobs('1'))[0]!.runAfter).toBe(sooner.toISOString());
  });

  it('does not claim a job before its run_after instant', async () => {
    await store.upsertJob({ auctionId: '1', kind: 'reveal', runAfter: new Date(Date.now() + 60_000) });
    expect(await store.claimJobs(['reveal'], 10, 30_000)).toHaveLength(0);
  });

  it('leases a job so a second worker cannot claim it concurrently', async () => {
    await store.upsertJob({ auctionId: '1', kind: 'reveal' });

    const first = await store.claimJobs(['reveal'], 10, 60_000);
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe('leased');
    expect(first[0]!.attempts).toBe(1);

    const second = await store.claimJobs(['reveal'], 10, 60_000);
    expect(second).toHaveLength(0);
  });

  it('returns a job to the pool once its lease lapses', async () => {
    await store.upsertJob({ auctionId: '1', kind: 'reveal' });
    const [leased] = await store.claimJobs(['reveal'], 10, -1);
    expect(leased).toBeDefined();

    // A negative lease is already expired, which is how a crashed worker's job
    // reappears rather than being stuck forever.
    const reclaimed = await store.claimJobs(['reveal'], 10, 30_000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBe(2);
  });

  it('filters by kind', async () => {
    await store.upsertJob({ auctionId: '1', kind: 'attest' });
    await store.upsertJob({ auctionId: '1', kind: 'settle' });
    expect(await store.claimJobs(['settle'], 10, 30_000)).toHaveLength(1);
    expect(await store.claimJobs(['reveal'], 10, 30_000)).toHaveLength(0);
  });

  it('does not resurrect a completed job', async () => {
    const job = await store.upsertJob({ auctionId: '1', kind: 'settle' });
    await store.completeJob(job.id);
    await store.upsertJob({ auctionId: '1', kind: 'settle', runAfter: new Date() });

    const [current] = await store.listJobs('1');
    expect(current!.status).toBe('done');
    expect(await store.claimJobs(['settle'], 10, 30_000)).toHaveLength(0);
  });

  it('keeps an abandoned job out of circulation', async () => {
    const job = await store.upsertJob({ auctionId: '1', kind: 'reveal' });
    await store.claimJobs(['reveal'], 10, 30_000);
    await store.abandonJob(job.id, 'attempt budget exhausted');
    await store.upsertJob({ auctionId: '1', kind: 'reveal', runAfter: new Date() });

    const [current] = await store.listJobs('1');
    expect(current!.status).toBe('failed');
    expect(current!.lastError).toBe('attempt budget exhausted');
    expect(await store.claimJobs(['reveal'], 10, 30_000)).toHaveLength(0);
  });

  it('re-pools a failed job with a delay and records the reason', async () => {
    const job = await store.upsertJob({ auctionId: '1', kind: 'reveal' });
    await store.claimJobs(['reveal'], 10, 30_000);
    await store.failJob(job.id, 'rpc blip', { retryAfterMs: 60_000 });

    const [current] = await store.listJobs('1');
    expect(current!.status).toBe('pending');
    expect(current!.lastError).toBe('rpc blip');
    expect(Date.parse(current!.runAfter)).toBeGreaterThan(Date.now());
    expect(await store.claimJobs(['reveal'], 10, 30_000)).toHaveLength(0);
  });
});

describe('MemoryStore envelopes and cache', () => {
  it('lists envelopes in a stable order and counts them', async () => {
    const store = new MemoryStore();
    for (const [bidder, createdAt] of [
      ['GB'.padEnd(56, 'A'), '2026-01-02T00:00:00.000Z'],
      ['GC'.padEnd(56, 'A'), '2026-01-01T00:00:00.000Z'],
    ] as const) {
      await store.putEnvelope({
        auctionId: '5',
        bidder,
        envelope: 'e',
        commitment: 'ab'.repeat(32),
        envelopeHash: 'cd'.repeat(32),
        createdAt,
      });
    }
    const rows = await store.listEnvelopes('5');
    expect(rows[0]!.createdAt < rows[1]!.createdAt).toBe(true);
    expect(await store.countEnvelopes('5')).toBe(2);
    expect(await store.countEnvelopes('6')).toBe(0);
  });

  it('replaces a bidder envelope on conflict', async () => {
    const store = new MemoryStore();
    const base = {
      auctionId: '5',
      bidder: 'GB'.padEnd(56, 'A'),
      envelope: 'first',
      commitment: 'ab'.repeat(32),
      envelopeHash: 'cd'.repeat(32),
      createdAt: new Date().toISOString(),
    };
    await store.putEnvelope(base);
    await store.putEnvelope({ ...base, envelope: 'second' });
    const rows = await store.listEnvelopes('5');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope).toBe('second');
  });

  it('lists the auction cache newest first', async () => {
    const store = new MemoryStore();
    for (const id of ['1', '2', '10']) {
      await store.upsertAuctionCache({
        auctionId: id,
        seller: 'GB'.padEnd(56, 'A'),
        phase: 'Sealed',
        reservePrice: '1000',
        bond: '100',
        commitDeadline: 100,
        revealDeadline: 200,
        fundingDeadline: 300,
        revealRound: 1000,
        sealedCount: 0,
        revealedCount: 0,
        winner: null,
        hammerPrice: '0',
        escrowed: '0',
        updatedAt: new Date().toISOString(),
      });
    }
    expect((await store.listAuctionCache(10)).map((row) => row.auctionId)).toEqual(['10', '2', '1']);
  });
});
