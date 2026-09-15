/**
 * In-memory store.
 *
 * Used by tests and by `npm run dev` without a database. It implements the same
 * semantics as the Postgres driver — including lease expiry and job idempotency — so
 * a test that passes here is exercising real behaviour rather than a simplified stub.
 */

import { randomUUID } from 'node:crypto';
import type {
  AttestationRecord,
  AuctionCacheRecord,
  EnvelopeRecord,
  EnqueueJobInput,
  JobKind,
  JobRecord,
  Store,
  SubmissionRecord,
} from './types.ts';

export class MemoryStore implements Store {
  private readonly envelopes = new Map<string, EnvelopeRecord>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly attestations = new Map<string, AttestationRecord>();
  private readonly submissions: SubmissionRecord[] = [];
  private readonly auctions = new Map<string, AuctionCacheRecord>();

  private static envelopeKey(auctionId: string, bidder: string): string {
    return `${auctionId}:${bidder}`;
  }

  private static jobKey(auctionId: string, kind: JobKind): string {
    return `${auctionId}:${kind}`;
  }

  /** Test helper: wipe everything between cases. */
  reset(): void {
    this.envelopes.clear();
    this.jobs.clear();
    this.attestations.clear();
    this.submissions.length = 0;
    this.auctions.clear();
  }

  async putEnvelope(record: EnvelopeRecord): Promise<void> {
    this.envelopes.set(MemoryStore.envelopeKey(record.auctionId, record.bidder), { ...record });
  }

  async getEnvelope(auctionId: string, bidder: string): Promise<EnvelopeRecord | undefined> {
    const found = this.envelopes.get(MemoryStore.envelopeKey(auctionId, bidder));
    return found ? { ...found } : undefined;
  }

  async listEnvelopes(auctionId: string, limit = 100): Promise<EnvelopeRecord[]> {
    return [...this.envelopes.values()]
      .filter((record) => record.auctionId === auctionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.bidder.localeCompare(b.bidder))
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async countEnvelopes(auctionId: string): Promise<number> {
    let count = 0;
    for (const record of this.envelopes.values()) {
      if (record.auctionId === auctionId) count++;
    }
    return count;
  }

  async upsertJob(input: EnqueueJobInput): Promise<JobRecord> {
    const key = MemoryStore.jobKey(input.auctionId, input.kind);
    const existing = this.jobs.get(key);
    const now = new Date().toISOString();
    const runAfter = (input.runAfter ?? new Date()).toISOString();

    if (existing) {
      // Re-running `upsert` moves the schedule earlier but never resurrects a
      // finished or abandoned job, which keeps the worker's duplicate-submission
      // window closed and stops a permanently broken auction from burning fees every
      // tick until an operator looks at it.
      if (existing.status === 'done' || existing.status === 'failed') {
        return { ...existing };
      }

      const updated: JobRecord = {
        ...existing,
        // Only pull the schedule earlier, never push it later.
        runAfter: runAfter < existing.runAfter ? runAfter : existing.runAfter,
        payload: { ...existing.payload, ...(input.payload ?? {}) },
        updatedAt: now,
      };
      this.jobs.set(key, updated);
      return { ...updated };
    }

    const created: JobRecord = {
      id: randomUUID(),
      auctionId: input.auctionId,
      kind: input.kind,
      status: 'pending',
      attempts: 0,
      runAfter,
      leaseUntil: null,
      lastError: null,
      payload: { ...(input.payload ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(key, created);
    return { ...created };
  }

  async claimJobs(kinds: readonly JobKind[], limit: number, leaseMs: number): Promise<JobRecord[]> {
    const now = Date.now();
    const claimed: JobRecord[] = [];

    for (const [key, job] of this.jobs) {
      if (claimed.length >= limit) break;

      if (job.status === 'leased' && job.leaseUntil !== null && Date.parse(job.leaseUntil) < now) {
        this.jobs.set(key, { ...job, status: 'pending', leaseUntil: null, updatedAt: new Date().toISOString() });
      }

      const current = this.jobs.get(key);
      if (!current || current.status !== 'pending') continue;
      if (!kinds.includes(current.kind)) continue;
      if (Date.parse(current.runAfter) > now) continue;

      const leased: JobRecord = {
        ...current,
        status: 'leased',
        attempts: current.attempts + 1,
        leaseUntil: new Date(now + leaseMs).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      this.jobs.set(key, leased);
      claimed.push({ ...leased });
    }

    return claimed.sort((a, b) => a.runAfter.localeCompare(b.runAfter));
  }

  async completeJob(id: string): Promise<void> {
    for (const [key, job] of this.jobs) {
      if (job.id === id) {
        this.jobs.set(key, {
          ...job,
          status: 'done',
          leaseUntil: null,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
    }
  }

  async failJob(id: string, error: string, options?: { retryAfterMs?: number }): Promise<void> {
    for (const [key, job] of this.jobs) {
      if (job.id !== id) continue;
      const retryAfterMs = options?.retryAfterMs;
      this.jobs.set(key, {
        ...job,
        status: 'pending',
        leaseUntil: null,
        lastError: error,
        runAfter: new Date(Date.now() + (retryAfterMs ?? 15_000)).toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }

  async abandonJob(id: string, error: string): Promise<void> {
    for (const [key, job] of this.jobs) {
      if (job.id !== id) continue;
      this.jobs.set(key, {
        ...job,
        status: 'failed',
        leaseUntil: null,
        lastError: error,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }

  async listJobs(auctionId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.auctionId === auctionId)
      .map((job) => ({ ...job }));
  }

  async putAttestation(record: AttestationRecord): Promise<void> {
    this.attestations.set(record.auctionId, {
      ...record,
      signerIndexes: [...record.signerIndexes],
      signatures: [...record.signatures],
    });
  }

  async getAttestation(auctionId: string): Promise<AttestationRecord | undefined> {
    const found = this.attestations.get(auctionId);
    return found ? { ...found } : undefined;
  }

  async recordSubmission(
    record: Omit<SubmissionRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<SubmissionRecord> {
    const entry: SubmissionRecord = {
      id: record.id ?? randomUUID(),
      auctionId: record.auctionId,
      method: record.method,
      status: record.status,
      hash: record.hash,
      ledger: record.ledger,
      error: record.error,
      createdAt: new Date().toISOString(),
    };
    this.submissions.push(entry);
    return entry;
  }

  async listSubmissions(auctionId: string, limit = 50): Promise<SubmissionRecord[]> {
    return this.submissions
      .filter((record) => record.auctionId === auctionId)
      .slice(-limit)
      .reverse();
  }

  async upsertAuctionCache(record: AuctionCacheRecord): Promise<void> {
    this.auctions.set(record.auctionId, { ...record });
  }

  async getAuctionCache(auctionId: string): Promise<AuctionCacheRecord | undefined> {
    const found = this.auctions.get(auctionId);
    return found ? { ...found } : undefined;
  }

  async listAuctionCache(limit: number, offset = 0): Promise<AuctionCacheRecord[]> {
    return [...this.auctions.values()]
      .sort((a, b) => Number(BigInt(b.auctionId) - BigInt(a.auctionId)))
      .slice(offset, offset + limit)
      .map((record) => ({ ...record }));
  }

  async migrate(): Promise<void> {
    // Nothing to do.
  }

  async health(): Promise<{ driver: 'memory'; ok: true }> {
    return { driver: 'memory', ok: true };
  }

  async close(): Promise<void> {
    this.reset();
  }
}
