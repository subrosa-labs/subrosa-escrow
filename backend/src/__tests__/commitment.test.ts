/**
 * Contract parity tests.
 *
 * The Rust contract computes these same two digests. If this file and
 * `contracts/subrosa_escrow/src/test.rs` ever disagree, the two halves of the
 * protocol are speaking different languages — and the symptom would be every reveal
 * failing with `CommitmentMismatch` after the money was already escrowed.
 *
 * These run offline: no RPC, no drand, no network. Pure encoders, fixed vectors.
 */

import { describe, expect, it } from 'vitest';
import vectors from './fixtures/golden-vectors.json' with { type: 'json' };
import {
  BEACON_PREIMAGE_LEN,
  BID_PREIMAGE_LEN,
  beaconPreimage,
  bidPreimage,
  computeBeaconDigest,
  computeCommitment,
} from '../drand/commitment.ts';
import { bytesToHex, hexToBytes32 } from '../util/bytes.ts';

describe('bid commitment', () => {
  it('matches the golden vector byte for byte', () => {
    const preimage = bidPreimage({
      auctionId: BigInt(vectors.bid.auctionId),
      amount: BigInt(vectors.bid.amount),
      salt: hexToBytes32(vectors.bid.salt),
    });

    expect(preimage.length).toBe(vectors.bid.preimageBytes);
    expect(bytesToHex(preimage)).toBe(vectors.bid.preimageHex);

    const commitment = computeCommitment({
      auctionId: BigInt(vectors.bid.auctionId),
      amount: BigInt(vectors.bid.amount),
      salt: hexToBytes32(vectors.bid.salt),
    });
    expect(bytesToHex(commitment)).toBe(vectors.bid.commitment);
  });

  it('places each field at the documented offset', () => {
    const preimage = bidPreimage({
      auctionId: 42n,
      amount: 1_500_000n,
      salt: new Uint8Array(32).fill(0xaa),
    });

    expect(BID_PREIMAGE_LEN).toBe(70);
    expect(preimage.length).toBe(BID_PREIMAGE_LEN);

    // domain | auction_id (u64 BE) | amount (i128 BE) | salt
    expect(Buffer.from(preimage.subarray(0, 14)).toString('ascii')).toBe('subrosa.bid.v1');
    expect(bytesToHex(preimage.subarray(14, 22))).toBe('000000000000002a');
    expect(bytesToHex(preimage.subarray(22, 38))).toBe('0000000000000000000000000016e360');
    expect(bytesToHex(preimage.subarray(38, 70))).toBe('aa'.repeat(32));
  });

  it('encodes amounts above 2^53 and above 2^63 exactly', () => {
    for (const vector of vectors.largeValues.cases) {
      const preimage = bidPreimage({
        auctionId: BigInt(vector.auctionId),
        amount: BigInt(vector.amount),
        salt: hexToBytes32(vector.salt),
      });
      expect(bytesToHex(preimage)).toBe(vector.preimageHex);

      const commitment = computeCommitment({
        auctionId: BigInt(vector.auctionId),
        amount: BigInt(vector.amount),
        salt: hexToBytes32(vector.salt),
      });
      expect(bytesToHex(commitment)).toBe(vector.commitment);
    }
  });

  it('uses two\\u2019s complement for negative values', () => {
    const preimage = bidPreimage({
      auctionId: BigInt(vectors.negative.auctionId),
      amount: BigInt(vectors.negative.amount),
      salt: hexToBytes32(vectors.negative.salt),
    });
    expect(bytesToHex(preimage)).toBe(vectors.negative.preimageHex);
    expect(bytesToHex(
      computeCommitment({
        auctionId: BigInt(vectors.negative.auctionId),
        amount: BigInt(vectors.negative.amount),
        salt: hexToBytes32(vectors.negative.salt),
      }),
    )).toBe(vectors.negative.commitment);
  });

  it('changes when any bound field changes', () => {
    const base = { auctionId: 42n, amount: 1_000_000n, salt: hexToBytes32(vectors.bid.salt) };
    const baseCommitment = bytesToHex(computeCommitment(base));

    expect(bytesToHex(computeCommitment({ ...base, auctionId: 43n }))).not.toBe(baseCommitment);
    expect(bytesToHex(computeCommitment({ ...base, amount: 1_000_001n }))).not.toBe(baseCommitment);
    expect(
      bytesToHex(computeCommitment({ ...base, salt: hexToBytes32(vectors.beacon.randomness) })),
    ).not.toBe(baseCommitment);
  });

  it('rejects a salt that is not 32 bytes', () => {
    expect(() =>
      bidPreimage({ auctionId: 1n, amount: 1n, salt: new Uint8Array(31) }),
    ).toThrow(/salt must be 32 bytes/);
  });
});

describe('beacon digest', () => {
  // The fixture carries the round as a decimal string; the encoder takes a number
  // or a bigint, so both are exercised below.
  const GOLDEN_ROUND = Number(vectors.beacon.round);

  it('matches the golden vector byte for byte', () => {
    const input = {
      chainHash: vectors.beacon.chainHash,
      round: GOLDEN_ROUND,
      randomnessHex: vectors.beacon.randomness,
      auctionId: BigInt(vectors.beacon.auctionId),
    };

    const preimage = beaconPreimage(input);
    expect(preimage.length).toBe(vectors.beacon.preimageBytes);
    expect(preimage.length).toBe(BEACON_PREIMAGE_LEN);
    expect(bytesToHex(preimage)).toBe(vectors.beacon.preimageHex);
    expect(bytesToHex(computeBeaconDigest(input))).toBe(vectors.beacon.digest);
  });

  it('accepts the round as a bigint as well as a number', () => {
    const asNumber = computeBeaconDigest({
      chainHash: vectors.beacon.chainHash,
      round: GOLDEN_ROUND,
      randomnessHex: vectors.beacon.randomness,
      auctionId: BigInt(vectors.beacon.auctionId),
    });
    const asBigInt = computeBeaconDigest({
      chainHash: vectors.beacon.chainHash,
      round: BigInt(GOLDEN_ROUND),
      randomnessHex: vectors.beacon.randomness,
      auctionId: BigInt(vectors.beacon.auctionId),
    });
    expect(bytesToHex(asNumber)).toBe(vectors.beacon.digest);
    expect(bytesToHex(asBigInt)).toBe(vectors.beacon.digest);
  });

  it('binds the auction id so an attestation cannot be replayed across auctions', () => {
    const base = {
      chainHash: vectors.beacon.chainHash,
      round: GOLDEN_ROUND,
      randomnessHex: vectors.beacon.randomness,
      auctionId: 42n,
    };
    expect(bytesToHex(computeBeaconDigest({ ...base, auctionId: 43n }))).not.toBe(
      bytesToHex(computeBeaconDigest(base)),
    );
  });

  it('binds the chain hash so a beacon from another network cannot be substituted', () => {
    const base = {
      chainHash: vectors.beacon.chainHash,
      round: 1_000,
      randomnessHex: vectors.beacon.randomness,
      auctionId: 42n,
    };
    const other = 'dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493';
    expect(bytesToHex(computeBeaconDigest({ ...base, chainHash: other }))).not.toBe(
      bytesToHex(computeBeaconDigest(base)),
    );
  });

  it('binds the round and the randomness', () => {
    const base = {
      chainHash: vectors.beacon.chainHash,
      round: 1_000,
      randomnessHex: vectors.beacon.randomness,
      auctionId: 42n,
    };
    expect(bytesToHex(computeBeaconDigest({ ...base, round: 1_001 }))).not.toBe(
      bytesToHex(computeBeaconDigest(base)),
    );
    expect(
      bytesToHex(computeBeaconDigest({ ...base, randomnessHex: 'ff'.repeat(32) })),
    ).not.toBe(bytesToHex(computeBeaconDigest(base)));
  });
});
