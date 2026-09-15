/**
 * Sealing and opening a bid, end to end.
 *
 * `sealBid` is the bidding client's flow and deliberately runs on the *bidder's*
 * machine in the browser build. The server-side copy exists for tests, for the CLI,
 * and for integration tooling — never for handling someone else's plaintext.
 *
 * `openBid` is what the relayer runs at reveal time, once the round's beacon exists
 * and the plaintext is public by construction.
 */

import { randomBytes32, bytesToHex, hexToBytes32, bytesEqual, type Bytes } from '../util/bytes.ts';
import { computeCommitment } from './commitment.ts';
import {
  SEALED_BID_VERSION,
  decodeSealedBid,
  encodeSealedBid,
  SealedBidFormatError,
  type SealedBid,
} from './sealed-bid.ts';
import { envelopeHash, openEnvelope, sealToRound } from './tlock.ts';
import { isRoundAvailable, roundTime, type DrandChain } from './chain.ts';

export interface SealBidParams {
  readonly auctionId: bigint;
  /** Amount in the settlement asset's smallest unit. */
  readonly amount: bigint;
  /** drand round the contract derived for this auction. */
  readonly revealRound: number;
  readonly chain: DrandChain;
  /** Optional salt, for deterministic tests. Never reuse one in production. */
  readonly salt?: Bytes;
  readonly bidder?: string;
  readonly createdAt?: number;
}

export interface ForbiddenSeal {
  readonly reason: 'round_in_past' | 'round_is_now';
  readonly message: string;
}

export interface SealedBidBundle {
  /** age-armored tlock ciphertext; this is the "envelope". */
  readonly envelope: string;
  /** `sha256(envelope)`, anchored on-chain by `seal_bid`. */
  readonly envelopeHash: Bytes;
  /** The commitment that binds `(auctionId, amount, salt)`. */
  readonly commitment: Bytes;
  /** Kept locally by the bidder so they can reveal even if our bulletin is down. */
  readonly salt: Bytes;
  readonly plaintext: SealedBid;
}

/**
 * Refuse to seal against a round that is already open.
 *
 * tlock will happily encrypt to a past round, producing what looks like a sealed
 * envelope that anyone can read instantly. That is a silent privacy failure, so it
 * is rejected at the boundary rather than trusted to the caller.
 */
export function assertRoundIsFuture(
  round: number,
  chain: DrandChain,
  nowMs = Date.now(),
): void {
  if (isRoundAvailable(round, chain, nowMs)) {
    throw new SealedBidFormatError(
      `reveal round ${round} was published at ${new Date(roundTime(round, chain) * 1000).toISOString()}; ` +
        'sealing to it would expose the bid immediately',
    );
  }
}

export async function sealBid(params: SealBidParams): Promise<SealedBidBundle> {
  const { auctionId, amount, revealRound, chain } = params;

  assertRoundIsFuture(revealRound, chain);
  if (amount <= 0n) {
    throw new SealedBidFormatError(`bid amount must be positive, got ${amount}`);
  }

  const salt = params.salt ?? randomBytes32();
  const commitment = computeCommitment({ auctionId, amount, salt });

  const plaintext: SealedBid = {
    v: SEALED_BID_VERSION,
    auctionId: auctionId.toString(),
    amount: amount.toString(),
    salt: bytesToHex(salt),
    commitment: bytesToHex(commitment),
    revealRound,
    chainHash: chain.chainHash,
    ...(params.bidder !== undefined ? { bidder: params.bidder } : {}),
    ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
  };

  const envelope = await sealToRound(encodeSealedBid(plaintext), revealRound, chain);

  return {
    envelope,
    envelopeHash: envelopeHash(envelope),
    commitment,
    salt,
    plaintext,
  };
}

export interface OpenedBid {
  readonly plaintext: SealedBid;
  /** Re-derived from the plaintext, not read from the payload. */
  readonly commitment: Bytes;
  readonly amount: bigint;
  readonly salt: Bytes;
}

/**
 * Open an envelope and re-derive the commitment from its contents.
 *
 * The payload carries its own `commitment` field, and this function checks it
 * against a fresh derivation. Two independent paths to the same value means a
 * corrupt or hand-edited envelope is caught here with a precise message, rather than
 * on-chain as an opaque `CommitmentMismatch` after a fee has been paid.
 */
export async function openBid(envelope: string, chain: DrandChain): Promise<OpenedBid> {
  const bytes = await openEnvelope(envelope, chain);
  const plaintext = decodeSealedBid(bytes);

  if (plaintext.chainHash !== chain.chainHash) {
    throw new SealedBidFormatError(
      `envelope is sealed to drand chain ${plaintext.chainHash} but ${chain.chainHash} is configured`,
    );
  }

  const salt = hexToBytes32(plaintext.salt, 'salt');
  const amount = BigInt(plaintext.amount);
  const commitment = computeCommitment({ auctionId: BigInt(plaintext.auctionId), amount, salt });

  const declared = hexToBytes32(plaintext.commitment, 'commitment');
  if (!bytesEqual(declared, commitment)) {
    throw new SealedBidFormatError(
      'envelope commitment does not match its own contents; the envelope was modified after sealing',
    );
  }

  return { plaintext, commitment, amount, salt };
}

/**
 * Verify a decrypted envelope against the commitment recorded on-chain.
 *
 * This is the check that makes reveal safe to run permissionlessly: the relayer (or
 * anyone else) can only submit an opening that matches what the bidder anchored.
 */
export function assertOpeningMatchesOnChainCommitment(
  opened: OpenedBid,
  onChainCommitment: Bytes,
  expectedAuctionId: bigint,
): void {
  if (BigInt(opened.plaintext.auctionId) !== expectedAuctionId) {
    throw new SealedBidFormatError(
      `envelope targets auction ${opened.plaintext.auctionId}, not ${expectedAuctionId}`,
    );
  }
  if (!bytesEqual(opened.commitment, onChainCommitment)) {
    throw new SealedBidFormatError(
      'envelope opens to an opening that does not match the on-chain commitment',
    );
  }
}
