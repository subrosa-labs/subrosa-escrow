/**
 * Canonical encodings shared with the Soroban contract.
 *
 * These two functions are the contract's `bid_commitment` and `beacon_digest`, and
 * they are pinned by golden-vector tests on both sides
 * (`backend/src/__tests__/commitment.test.ts` and `contracts/.../src/test.rs`).
 *
 * A drift in either direction is catastrophic in a quiet way: the commitment would
 * still look valid, the envelope would still decrypt, and every reveal would fail
 * on-chain with `CommitmentMismatch` after the money is already escrowed. The
 * golden vectors exist so that drift fails in CI instead.
 *
 * ```text
 * commitment = sha256("subrosa.bid.v1"    || auction_id || amount  || salt)
 *              ^ 14 bytes            ^ u64 BE     ^ i128 BE  ^ 32 bytes
 *
 * digest     = sha256("subrosa.beacon.v1" || chain_hash || round  || randomness || auction_id)
 *              ^ 17 bytes                  ^ 32 bytes   ^ u64 BE ^ 32 bytes    ^ u64 BE
 * ```
 *
 * Note what is *absent* from the commitment: the bidder's address. It does not need
 * to be there. `seal_bid` files a bid under the address that authenticated it, and
 * `reveal_bid` looks the bid up under that same stored address, so a stranger who
 * learns an opening can only credit the original bidder. Binding `auction_id` is
 * what stops an opening from being replayed into a different auction.
 */

import { concatBytes, hexToBytes32, i128be, sha256, u64be, utf8, type Bytes } from '../util/bytes.ts';

/** ASCII domain separator for the bid commitment. Must match `DOMAIN_BID` in Rust. */
export const BID_DOMAIN = 'subrosa.bid.v1';

/** ASCII domain separator for the beacon attestation digest. Must match `DOMAIN_BEACON`. */
export const BEACON_DOMAIN = 'subrosa.beacon.v1';

/** Byte lengths, asserted so a refactor cannot silently change the layout. */
export const BID_PREIMAGE_LEN = 14 + 8 + 16 + 32;
export const BEACON_PREIMAGE_LEN = 17 + 32 + 8 + 32 + 8;

export interface CommitmentInput {
  readonly auctionId: bigint;
  /** Bid amount in the settlement asset's smallest unit. */
  readonly amount: bigint;
  /** 32-byte salt. */
  readonly salt: Bytes;
}

/** The exact bytes hashed to produce a bid commitment. */
export function bidPreimage(input: CommitmentInput): Bytes {
  if (input.salt.length !== 32) {
    throw new Error(`salt must be 32 bytes, got ${input.salt.length}`);
  }
  const preimage = concatBytes(
    utf8(BID_DOMAIN),
    u64be(input.auctionId),
    i128be(input.amount),
    input.salt,
  );
  if (preimage.length !== BID_PREIMAGE_LEN) {
    throw new Error(`bid preimage must be ${BID_PREIMAGE_LEN} bytes, got ${preimage.length}`);
  }
  return preimage;
}

/** `sha256(preimage)`, the 32 bytes stored on-chain at seal time. */
export function computeCommitment(input: CommitmentInput): Bytes {
  return sha256(bidPreimage(input));
}

/** Convenience wrappers for callers that receive hex from JSON. */
export function commitmentFromHex(
  auctionId: bigint,
  amount: bigint,
  saltHex: string,
): Bytes {
  return computeCommitment({ auctionId, amount, salt: hexToBytes32(saltHex, 'salt') });
}

export interface BeaconDigestInput {
  readonly chainHash: string;
  readonly round: number | bigint;
  /** The beacon's `randomness` field, 32 bytes. */
  readonly randomnessHex: string;
  readonly auctionId: bigint;
}

/** The exact bytes a relayer signs to attest a beacon for one auction. */
export function beaconPreimage(input: BeaconDigestInput): Bytes {
  const preimage = concatBytes(
    utf8(BEACON_DOMAIN),
    hexToBytes32(input.chainHash, 'chainHash'),
    u64be(BigInt(input.round)),
    hexToBytes32(input.randomnessHex, 'randomness'),
    u64be(input.auctionId),
  );
  if (preimage.length !== BEACON_PREIMAGE_LEN) {
    throw new Error(
      `beacon preimage must be ${BEACON_PREIMAGE_LEN} bytes, got ${preimage.length}`,
    );
  }
  return preimage;
}

/** `sha256(preimage)`, the message relayers sign. */
export function computeBeaconDigest(input: BeaconDigestInput): Bytes {
  return sha256(beaconPreimage(input));
}
