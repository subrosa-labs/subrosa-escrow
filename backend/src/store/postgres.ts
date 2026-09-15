/**
 * Postgres store.
 *
 * The job queue is the interesting part. Two properties matter when several relayer
 * processes run at once:
 *
 * * **Leases, not locks.** `claimJobs` reclaims expired leases and then picks work
 *   with `FOR UPDATE SKIP LOCKED`, so a crashed worker's job reappears after its
 *   lease lapses instead of being stuck forever.
 * * **One live job per (auction, kind).** Enforced by a unique constraint, so
 *   `upsertJob` is idempotent. Two workers waking up at the same moment cannot both
 *   decide to reveal the same auction and pay two fees for one reveal.
 */

import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

export interface PostgresStoreOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

interface JobRow {
  id: string;
  auction_id: string;
  kind: JobKind;
  status: JobRecord['status'];
  attempts: number;
  run_after: Date;
  lease_until: Date | null;
  last_error: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export class PostgresStore implements Store {
  private readonly pool: Pool;

  constructor(options: PostgresStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 8,
      application_name: options.applicationName ?? 'subrosa-relayer',
    });
  }

  private async query<T extends object>(sql: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(sql, values);
    return result.rows;
  }

  async migrate(): Promise<void> {
    const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
    const sql = await readFile(schemaPath, 'utf8');
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async health(): Promise<{ driver: 'postgres'; ok: boolean; detail?: string }> {
    try {
      await this.pool.query('SELECT 1');
      return { driver: 'postgres', ok: true };
    } catch (error) {
      return {
        driver: 'postgres',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // -- envelopes -------------------------------------------------------------

  async putEnvelope(record: EnvelopeRecord): Promise<void> {
    await this.query(
      `INSERT INTO envelopes (auction_id, bidder, envelope, commitment, envelope_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (auction_id, bidder) DO UPDATE
         SET envelope = EXCLUDED.envelope,
             commitment = EXCLUDED.commitment,
             envelope_hash = EXCLUDED.envelope_hash`,
      [
        record.auctionId,
        record.bidder,
        record.envelope,
        record.commitment,
        record.envelopeHash,
        record.createdAt,
      ],
    );
  }

  async getEnvelope(auctionId: string, bidder: string): Promise<EnvelopeRecord | undefined> {
    const rows = await this.query<{
      auction_id: string;
      bidder: string;
      envelope: string;
      commitment: string;
      envelope_hash: string;
      created_at: Date;
    }>(
      `SELECT auction_id, bidder, envelope, commitment, envelope_hash, created_at
         FROM envelopes WHERE auction_id = $1 AND bidder = $2`,
      [auctionId, bidder],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      auctionId: row.auction_id,
      bidder: row.bidder,
      envelope: row.envelope,
      commitment: row.commitment,
      envelopeHash: row.envelope_hash,
      createdAt: row.created_at.toISOString(),
    };
  }

  async listEnvelopes(auctionId: string, limit = 100): Promise<EnvelopeRecord[]> {
    const rows = await this.query<{
      auction_id: string;
      bidder: string;
      envelope: string;
      commitment: string;
      envelope_hash: string;
      created_at: Date;
    }>(
      `SELECT auction_id, bidder, envelope, commitment, envelope_hash, created_at
         FROM envelopes WHERE auction_id = $1 ORDER BY created_at, bidder LIMIT $2`,
      [auctionId, limit],
    );
    return rows.map((row) => ({
      auctionId: row.auction_id,
      bidder: row.bidder,
      envelope: row.envelope,
      commitment: row.commitment,
      envelopeHash: row.envelope_hash,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async countEnvelopes(auctionId: string): Promise<number> {
    const rows = await this.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM envelopes WHERE auction_id = $1',
      [auctionId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // -- jobs ------------------------------------------------------------------

  async upsertJob(input: EnqueueJobInput): Promise<JobRecord> {
    const rows = await this.query<JobRow>(
      `INSERT INTO jobs (auction_id, kind, run_after, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (auction_id, kind) DO UPDATE
         SET run_after = LEAST(jobs.run_after, EXCLUDED.run_after),
             payload = jobs.payload || EXCLUDED.payload,
             updated_at = now()
         -- Never resurrect a finished or abandoned job by scheduling it again, so a
         -- permanently broken auction cannot burn a fee on every observe tick.
         WHERE jobs.status NOT IN ('done', 'failed')
       RETURNING *`,
      [
        input.auctionId,
        input.kind,
        (input.runAfter ?? new Date()).toISOString(),
        JSON.stringify(input.payload ?? {}),
      ],
    );

    if (rows[0]) return mapJob(rows[0]);

    const existing = await this.query<JobRow>(
      'SELECT * FROM jobs WHERE auction_id = $1 AND kind = $2',
      [input.auctionId, input.kind],
    );
    const row = existing[0];
    if (!row) throw new Error('job upsert returned neither a new nor an existing row');
    return mapJob(row);
  }

  async claimJobs(kinds: readonly JobKind[], limit: number, leaseMs: number): Promise<JobRecord[]> {
    const rows = await this.query<JobRow>(
      `WITH reclaimed AS (
         UPDATE jobs SET status = 'pending', lease_until = NULL, updated_at = now()
          WHERE status = 'leased' AND lease_until IS NOT NULL AND lease_until < now()
          RETURNING id
       ),
       picked AS (
         SELECT id FROM jobs
          WHERE status = 'pending' AND run_after <= now() AND kind = ANY($1::text[])
          ORDER BY run_after
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE jobs
          SET status = 'leased',
              lease_until = now() + ($3::text || ' milliseconds')::interval,
              attempts = jobs.attempts + 1,
              updated_at = now()
         FROM picked
        WHERE jobs.id = picked.id
        RETURNING jobs.*`,
      [[...kinds], limit, String(leaseMs)],
    );
    return rows.map(mapJob);
  }

  async completeJob(id: string): Promise<void> {
    await this.query("UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = now() WHERE id = $1", [id]);
  }

  async failJob(id: string, error: string, options?: { retryAfterMs?: number }): Promise<void> {
    await this.query(
      `UPDATE jobs
          SET status = 'pending',
              lease_until = NULL,
              last_error = $2,
              run_after = now() + ($3::text || ' milliseconds')::interval,
              updated_at = now()
        WHERE id = $1`,
      [id, error.slice(0, 2_000), String(options?.retryAfterMs ?? 15_000)],
    );
  }

  async abandonJob(id: string, error: string): Promise<void> {
    await this.query(
      `UPDATE jobs SET status = 'failed', lease_until = NULL, last_error = $2, updated_at = now()
        WHERE id = $1`,
      [id, error.slice(0, 2_000)],
    );
  }

  async listJobs(auctionId: string): Promise<JobRecord[]> {
    const rows = await this.query<JobRow>('SELECT * FROM jobs WHERE auction_id = $1 ORDER BY kind', [
      auctionId,
    ]);
    return rows.map(mapJob);
  }

  // -- attestations ----------------------------------------------------------

  async putAttestation(record: AttestationRecord): Promise<void> {
    await this.query(
      `INSERT INTO attestations
         (auction_id, round, randomness, committee_size, threshold, signer_indexes, signatures)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (auction_id) DO NOTHING`,
      [
        record.auctionId,
        record.round,
        record.randomness,
        record.committeeSize,
        record.threshold,
        [...record.signerIndexes],
        [...record.signatures],
      ],
    );
  }

  async getAttestation(auctionId: string): Promise<AttestationRecord | undefined> {
    const rows = await this.query<{
      auction_id: string;
      round: string;
      randomness: string;
      committee_size: number;
      threshold: number;
      signer_indexes: number[];
      signatures: string[];
      created_at: Date;
    }>('SELECT * FROM attestations WHERE auction_id = $1', [auctionId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      auctionId: row.auction_id,
      round: Number(row.round),
      randomness: row.randomness,
      committeeSize: row.committee_size,
      threshold: row.threshold,
      signerIndexes: row.signer_indexes,
      signatures: row.signatures,
      createdAt: row.created_at.toISOString(),
    };
  }

  // -- submissions -----------------------------------------------------------

  async recordSubmission(
    record: Omit<SubmissionRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<SubmissionRecord> {
    const rows = await this.query<{
      id: string;
      auction_id: string | null;
      method: string;
      status: SubmissionRecord['status'];
      hash: string | null;
      ledger: string | null;
      error: string | null;
      created_at: Date;
    }>(
      `INSERT INTO submissions (auction_id, method, status, hash, ledger, error)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        record.auctionId,
        record.method,
        record.status,
        record.hash,
        record.ledger === null ? null : String(record.ledger),
        record.error,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('submission insert returned no row');
    return {
      id: row.id,
      auctionId: row.auction_id,
      method: row.method,
      status: row.status,
      hash: row.hash,
      ledger: row.ledger === null ? null : Number(row.ledger),
      error: row.error,
      createdAt: row.created_at.toISOString(),
    };
  }

  async listSubmissions(auctionId: string, limit = 50): Promise<SubmissionRecord[]> {
    const rows = await this.query<{
      id: string;
      auction_id: string | null;
      method: string;
      status: SubmissionRecord['status'];
      hash: string | null;
      ledger: string | null;
      error: string | null;
      created_at: Date;
    }>(
      `SELECT * FROM submissions WHERE auction_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [auctionId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      auctionId: row.auction_id,
      method: row.method,
      status: row.status,
      hash: row.hash,
      ledger: row.ledger === null ? null : Number(row.ledger),
      error: row.error,
      createdAt: row.created_at.toISOString(),
    }));
  }

  // -- auction cache ---------------------------------------------------------

  async upsertAuctionCache(record: AuctionCacheRecord): Promise<void> {
    await this.query(
      `INSERT INTO auctions_cache
         (auction_id, seller, phase, reserve_price, bond, commit_deadline, reveal_deadline,
          funding_deadline, reveal_round, sealed_count, revealed_count, winner, hammer_price,
          escrowed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (auction_id) DO UPDATE SET
         phase = EXCLUDED.phase,
         sealed_count = EXCLUDED.sealed_count,
         revealed_count = EXCLUDED.revealed_count,
         winner = EXCLUDED.winner,
         hammer_price = EXCLUDED.hammer_price,
         escrowed = EXCLUDED.escrowed,
         updated_at = now()`,
      [
        record.auctionId,
        record.seller,
        record.phase,
        record.reservePrice,
        record.bond,
        record.commitDeadline,
        record.revealDeadline,
        record.fundingDeadline,
        record.revealRound,
        record.sealedCount,
        record.revealedCount,
        record.winner,
        record.hammerPrice,
        record.escrowed,
      ],
    );
  }

  async getAuctionCache(auctionId: string): Promise<AuctionCacheRecord | undefined> {
    const rows = await this.query<Record<string, string | number | null>>(
      'SELECT * FROM auctions_cache WHERE auction_id = $1',
      [auctionId],
    );
    const row = rows[0];
    return row ? mapAuctionCache(row) : undefined;
  }

  async listAuctionCache(limit: number, offset = 0): Promise<AuctionCacheRecord[]> {
    const rows = await this.query<Record<string, string | number | null>>(
      'SELECT * FROM auctions_cache ORDER BY auction_id DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    return rows.map(mapAuctionCache);
  }
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    auctionId: row.auction_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    runAfter: row.run_after.toISOString(),
    leaseUntil: row.lease_until ? row.lease_until.toISOString() : null,
    lastError: row.last_error,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapAuctionCache(row: Record<string, string | number | null>): AuctionCacheRecord {
  const str = (key: string): string => String(row[key] ?? '');
  return {
    auctionId: str('auction_id'),
    seller: str('seller'),
    phase: str('phase') as AuctionCacheRecord['phase'],
    reservePrice: str('reserve_price'),
    bond: str('bond'),
    commitDeadline: Number(row['commit_deadline'] ?? 0),
    revealDeadline: Number(row['reveal_deadline'] ?? 0),
    fundingDeadline: Number(row['funding_deadline'] ?? 0),
    revealRound: Number(row['reveal_round'] ?? 0),
    sealedCount: Number(row['sealed_count'] ?? 0),
    revealedCount: Number(row['revealed_count'] ?? 0),
    winner: row['winner'] === null ? null : str('winner'),
    hammerPrice: str('hammer_price'),
    escrowed: str('escrowed'),
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}
