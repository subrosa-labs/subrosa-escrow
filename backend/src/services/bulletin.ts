/**
 * The sealed-envelope bulletin board.
 *
 * Why envelopes live off-chain at all: an age-armored tlock ciphertext for a small
 * bid is roughly 600-900 bytes. Putting that in a ledger entry for every bidder
 * would cost real XLM for data that the chain does not need, because the contract
 * only ever needs the *hash* to keep the ciphertext tamper-evident.
 *
 * That trade is safe specifically because reveal is permissionless. If this service
 * loses an envelope, or censors one, the bidder can still reveal from their own copy
 * — the on-chain hash proves which bytes are the right ones, and no one can
 * substitute a different envelope. So this is an availability dependency, never a
 * correctness or privacy one.
 *
 * The bulletin deliberately accepts the envelope *and* the hashes the client claims
 * for it, then recomputes both. A client that sends a mismatched pair gets a clear
 * rejection here rather than a confusing `EnvelopeHashMismatch` at reveal time, after
 * the bond is already escrowed.
 */

import { childLogger, type Logger } from '../logger.ts';
import type { Config } from '../config.ts';
import type { Store, EnvelopeRecord } from '../store/types.ts';
import { bytesToHex, hexToBytes32, sha256 } from '../util/bytes.ts';
import { envelopeHash as computeEnvelopeHash, isArmoredEnvelope } from '../drand/tlock.ts';

export class BulletinError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'BulletinError';
  }
}

export interface PublishEnvelopeInput {
  readonly auctionId: bigint;
  readonly bidder: string;
  /** age-armored tlock ciphertext. */
  readonly envelope: string;
  /** `sha256(preimage)` as claimed by the client, hex. */
  readonly commitment: string;
  /** `sha256(envelope)` as claimed by the client, hex. */
  readonly envelopeHash: string;
}

export class EnvelopeBulletin {
  private readonly log: Logger;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {
    this.log = childLogger('bulletin');
  }

  /** Validate, integrity-check, and store an envelope. */
  async publish(input: PublishEnvelopeInput): Promise<EnvelopeRecord> {
    const auctionId = input.auctionId.toString();

    if (input.envelope.length > this.config.MAX_ENVELOPE_BYTES) {
      throw new BulletinError(
        `envelope is ${input.envelope.length} bytes; limit is ${this.config.MAX_ENVELOPE_BYTES}`,
        413,
      );
    }
    if (!isArmoredEnvelope(input.envelope)) {
      throw new BulletinError(
        'envelope must be an age-armored tlock ciphertext (-----BEGIN AGE ENCRYPTED FILE-----)',
      );
    }

    const claimedHash = bytesToHex(hexToBytes32(input.envelopeHash, 'envelopeHash'));
    const actualHash = bytesToHex(computeEnvelopeHash(input.envelope));
    if (claimedHash !== actualHash) {
      throw new BulletinError(
        `envelopeHash does not match sha256(envelope): claimed ${claimedHash}, computed ${actualHash}`,
      );
    }

    const commitment = bytesToHex(hexToBytes32(input.commitment, 'commitment'));

    const existing = await this.store.getEnvelope(auctionId, input.bidder);
    if (existing && existing.envelopeHash !== claimedHash) {
      throw new BulletinError(
        'this bidder has already published a different envelope for this auction',
        409,
      );
    }

    const count = await this.store.countEnvelopes(auctionId);
    if (!existing && count >= this.config.MAX_ENVELOPES_PER_AUCTION) {
      throw new BulletinError(
        `auction ${auctionId} already holds ${count} envelopes; limit is ${this.config.MAX_ENVELOPES_PER_AUCTION}`,
        429,
      );
    }

    const record: EnvelopeRecord = {
      auctionId,
      bidder: input.bidder,
      envelope: input.envelope,
      commitment,
      envelopeHash: claimedHash,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    await this.store.putEnvelope(record);

    this.log.info(
      { auctionId, bidder: input.bidder, envelopeHash: claimedHash },
      'envelope published',
    );

    return record;
  }

  async get(auctionId: bigint, bidder: string): Promise<EnvelopeRecord | undefined> {
    return this.store.getEnvelope(auctionId.toString(), bidder);
  }

  async list(auctionId: bigint): Promise<EnvelopeRecord[]> {
    return this.store.listEnvelopes(auctionId.toString(), this.config.MAX_ENVELOPES_PER_AUCTION);
  }

  /**
   * Cheap integrity re-check over a whole auction, used before revealing.
   *
   * If a row was corrupted at rest, this drops it here instead of burning a
   * transaction on an envelope that could never satisfy the on-chain hash.
   */
  async verified(auctionId: bigint): Promise<{ usable: EnvelopeRecord[]; corrupted: EnvelopeRecord[] }> {
    const records = await this.list(auctionId);
    const usable: EnvelopeRecord[] = [];
    const corrupted: EnvelopeRecord[] = [];

    for (const record of records) {
      const digest = bytesToHex(sha256(new Uint8Array(Buffer.from(record.envelope, 'utf8'))));
      if (digest === record.envelopeHash) {
        usable.push(record);
      } else {
        corrupted.push(record);
        this.log.error(
          { auctionId: auctionId.toString(), bidder: record.bidder },
          'envelope failed its own hash check at rest; excluding from reveal',
        );
      }
    }

    return { usable, corrupted };
  }
}
