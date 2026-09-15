/**
 * Persistence contracts.
 *
 * What lives here and what does not is a deliberate split:
 *
 * * **On-chain** is the source of truth for auction state, bids, escrow and
 *   outcomes. Nothing in this store may contradict it.
 * * **This store** holds only things the chain cannot: sealed envelopes (whose
 *   integrity is anchored on-chain by hash), relayer attestations, the job queue,
 *   a submission audit log, and a read-through cache for listing.
 *
 * Every id is a decimal string, because `u64` auction ids do not survive a `number`.
 */

import type { Phase } from '../stellar/contract.ts';

/**
 * Work the relayer does for one auction.
 *
 * Three kinds, matching the three things that can only happen after a drand round
 * becomes live: publishing the beacon attestation, opening envelopes, and releasing
 * escrow. `observe` is not a job kind — it is the scan that schedules these.
 */
export type JobKind = 'attest' | 'reveal' | 'settle';

export type JobStatus = 'pending' | 'leased' | 'done' | 'failed';

export interface EnvelopeRecord {
  readonly auctionId: string;
  readonly bidder: string;
  /** age-armored tlock ciphertext. */
  readonly envelope: string;
  /** `sha256(preimage)`, hex. Must equal the on-chain commitment. */
  readonly commitment: string;
  /** `sha256(envelope)`, hex. Must equal the on-chain `envelope_hash`. */
  readonly envelopeHash: string;
  readonly createdAt: string;
}

export interface JobRecord {
  readonly id: string;
  readonly auctionId: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly runAfter: string;
  readonly leaseUntil: string | null;
  readonly lastError: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueueJobInput {
  readonly auctionId: string;
  readonly kind: JobKind;
  /** Do not run before this instant. Used to align with drand rounds. */
  readonly runAfter?: Date;
  readonly payload?: Record<string, unknown>;
}

export interface AttestationRecord {
  readonly auctionId: string;
  readonly round: number;
  readonly randomness: string;
  readonly committeeSize: number;
  readonly threshold: number;
  /** On-chain indices, ascending. */
  readonly signerIndexes: readonly number[];
  /** ed25519 signatures, hex, aligned with `signerIndexes`. */
  readonly signatures: readonly string[];
  readonly createdAt: string;
}

export interface SubmissionRecord {
  readonly id: string;
  readonly auctionId: string | null;
  readonly method: string;
  readonly status: 'submitted' | 'confirmed' | 'failed';
  readonly hash: string | null;
  readonly ledger: number | null;
  readonly error: string | null;
  readonly createdAt: string;
}

export interface AuctionCacheRecord {
  readonly auctionId: string;
  readonly seller: string;
  readonly phase: Phase;
  readonly reservePrice: string;
  readonly bond: string;
  readonly commitDeadline: number;
  readonly revealDeadline: number;
  readonly fundingDeadline: number;
  readonly revealRound: number;
  readonly sealedCount: number;
  readonly revealedCount: number;
  readonly winner: string | null;
  readonly hammerPrice: string;
  readonly escrowed: string;
  readonly updatedAt: string;
}

export interface Store {
  // -- sealed envelopes -----------------------------------------------------
  putEnvelope(record: EnvelopeRecord): Promise<void>;
  getEnvelope(auctionId: string, bidder: string): Promise<EnvelopeRecord | undefined>;
  listEnvelopes(auctionId: string, limit?: number): Promise<EnvelopeRecord[]>;
  countEnvelopes(auctionId: string): Promise<number>;

  // -- job queue -----------------------------------------------------------
  /** Insert or refresh a job for `(auctionId, kind)`. Idempotent. */
  upsertJob(input: EnqueueJobInput): Promise<JobRecord>;
  claimJobs(kinds: readonly JobKind[], limit: number, leaseMs: number): Promise<JobRecord[]>;
  completeJob(id: string): Promise<void>;
  failJob(id: string, error: string, options?: { retryAfterMs?: number }): Promise<void>;
  /**
   * Give up on a job after its attempt budget is spent.
   *
   * Distinct from `completeJob` because an abandoned job must stay abandoned: it is
   * excluded from re-scheduling until an operator clears it, so a permanently broken
   * auction cannot burn fees on every tick forever.
   */
  abandonJob(id: string, error: string): Promise<void>;
  listJobs(auctionId: string): Promise<JobRecord[]>;

  // -- relayer attestations ------------------------------------------------
  putAttestation(record: AttestationRecord): Promise<void>;
  getAttestation(auctionId: string): Promise<AttestationRecord | undefined>;

  // -- submission audit ----------------------------------------------------
  recordSubmission(record: Omit<SubmissionRecord, 'id' | 'createdAt'> & { id?: string }): Promise<SubmissionRecord>;
  listSubmissions(auctionId: string, limit?: number): Promise<SubmissionRecord[]>;

  // -- read-through cache --------------------------------------------------
  upsertAuctionCache(record: AuctionCacheRecord): Promise<void>;
  getAuctionCache(auctionId: string): Promise<AuctionCacheRecord | undefined>;
  listAuctionCache(limit: number, offset?: number): Promise<AuctionCacheRecord[]>;

  // -- lifecycle -----------------------------------------------------------
  migrate(): Promise<void>;
  health(): Promise<{ driver: 'memory' | 'postgres'; ok: boolean; detail?: string }>;
  close(): Promise<void>;
}
