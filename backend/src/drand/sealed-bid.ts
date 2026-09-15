/**
 * The sealed-bid payload.
 *
 * This is the *only* thing that ever gets timelock-encrypted. It never touches disk
 * in plaintext, never reaches this backend in plaintext, and does not exist in
 * plaintext anywhere in the world until the reveal round's threshold signature is
 * published.
 *
 * The backend only ever sees it *after* the round, when it is already public
 * information by construction.
 *
 * ## Why the encoding is fixed
 *
 * The commitment is derived from `(auctionId, amount, salt)` — not from these JSON
 * bytes — so strictly speaking the encoding does not have to be canonical for
 * correctness. It is canonical anyway, with a fixed key order and no insignificant
 * whitespace, for a different reason: it makes the envelope's *hash* a stable
 * function of its semantic content, which is what the on-chain `envelope_hash` is
 * anchored to. Without that, a client that re-serialised an envelope before
 * submitting it at reveal time would fail the on-chain hash check for no
 * discernible reason.
 *
 * Integers that can exceed `Number.MAX_SAFE_INTEGER` — amounts and auction ids —
 * travel as decimal strings. A `number` in JSON would silently corrupt large i128
 * amounts, and the failure would surface as an unrevealable bid.
 */

import { z } from 'zod';

/** Bump when the sealed payload shape changes; older envelopes stay readable. */
export const SEALED_BID_VERSION = 1;

const decimalString = (field: string) =>
  z
    .string()
    .regex(/^\d+$/, `${field} must be a non-negative decimal integer string`);

const hex32 = (field: string) =>
  z.string().regex(/^[0-9a-f]{64}$/, `${field} must be 32 bytes of lowercase hex`);

export const sealedBidSchema = z.object({
  /** Payload version. */
  v: z.literal(SEALED_BID_VERSION),
  /** Auction this bid targets, as a decimal string (u64). */
  auctionId: decimalString('auctionId'),
  /** Bid amount in the settlement asset's smallest unit, decimal string (i128). */
  amount: decimalString('amount'),
  /** 32-byte salt, hex. Prevents anyone who guesses the amount from opening it. */
  salt: hex32('salt'),
  /**
   * `sha256(commitment preimage)`, hex.
   *
   * Redundant with the on-chain commitment on purpose. The relayer checks both
   * against each other at reveal time, so a corrupt envelope is rejected with a
   * clear reason instead of a confusing on-chain mismatch.
   */
  commitment: hex32('commitment'),
  /** drand round this envelope is encrypted to. */
  revealRound: z.number().int().positive(),
  /** drand chain hash this envelope is encrypted to. */
  chainHash: hex32('chainHash'),
  /** Bidder's Stellar address. Informational; it is *not* part of the commitment. */
  bidder: z.string().length(56).optional(),
  /** Client-declared creation time, unix seconds. Informational only. */
  createdAt: z.number().int().nonnegative().optional(),
});

export type SealedBid = z.infer<typeof sealedBidSchema>;

export class SealedBidFormatError extends Error {
  constructor(
    message: string,
    readonly issues?: readonly string[],
  ) {
    // Fold the individual field problems into the message. A bare "failed
    // validation" is useless in a log line at 3am; the operator needs to know which
    // field and why.
    super(issues && issues.length > 0 ? `${message}: ${issues.join('; ')}` : message);
    this.name = 'SealedBidFormatError';
  }
}

/**
 * Encode a sealed bid deterministically.
 *
 * Key order is fixed by construction here rather than by `JSON.stringify`, whose
 * integer-like key ordering rules are easy to trip over.
 */
export function encodeSealedBid(bid: SealedBid): Uint8Array {
  const ordered: Record<string, unknown> = {
    v: bid.v,
    auctionId: bid.auctionId,
    amount: bid.amount,
    salt: bid.salt,
    commitment: bid.commitment,
    revealRound: bid.revealRound,
    chainHash: bid.chainHash,
  };
  if (bid.bidder !== undefined) ordered.bidder = bid.bidder;
  if (bid.createdAt !== undefined) ordered.createdAt = bid.createdAt;

  return new Uint8Array(Buffer.from(JSON.stringify(ordered), 'utf8'));
}

/** Parse and validate a decrypted sealed bid. Throws with every issue listed. */
export function decodeSealedBid(bytes: Uint8Array): SealedBid {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new SealedBidFormatError('sealed bid is not valid JSON');
  }

  const result = sealedBidSchema.safeParse(parsed);
  if (!result.success) {
    throw new SealedBidFormatError(
      'sealed bid failed validation',
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
