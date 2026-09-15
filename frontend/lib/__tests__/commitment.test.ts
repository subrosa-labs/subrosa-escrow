/**
 * Byte-parity tests for the browser encoders.
 *
 * `frontend/lib/commitment.ts` is a deliberate re-implementation of
 * `backend/src/drand/commitment.ts` — it has to be, because the commitment is computed in
 * the bidder's browser and no plaintext ever reaches a server. The risk of a duplicate
 * implementation is that the two drift, and the failure mode is nasty: the seal succeeds
 * on-chain, the bond is escrowed, and the reveal is rejected with `CommitmentMismatch` a
 * day later.
 *
 * These vectors are the shared fixture that the Rust contract's `golden_*` tests and the
 * backend's tests also read. If this file and one of those disagree, one of them is wrong
 * and CI says so before anything is deployed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BID_PREIMAGE_LEN,
  bidPreimage,
  bytesToHex,
  computeCommitment,
  EncodingError,
  hexToBytes,
  hexToBytes32,
  i128be,
  u64be,
  utf8,
} from '../commitment.ts';

interface BidVector {
  auctionId: string;
  amount: string;
  salt: string;
  preimageHex: string;
  commitment: string;
}

interface Vectors {
  bid: BidVector;
  largeValues: { cases: BidVector[] };
  negative: BidVector;
}

const vectors: Vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../backend/src/__tests__/fixtures/golden-vectors.json', import.meta.url)),
    'utf8',
  ),
) as Vectors;

async function assertVector(vector: BidVector, label: string): Promise<void> {
  const input = {
    auctionId: BigInt(vector.auctionId),
    amount: BigInt(vector.amount),
    salt: hexToBytes(vector.salt),
  };

  expect(bytesToHex(bidPreimage(input)), `${label}: preimage`).toBe(vector.preimageHex);
  expect(bidPreimage(input).length, `${label}: preimage length`).toBe(BID_PREIMAGE_LEN);
  expect(bytesToHex(await computeCommitment(input)), `${label}: commitment`).toBe(vector.commitment);
}

describe('bid commitment', () => {
  it('matches the canonical vector', async () => {
    await assertVector(vectors.bid, 'canonical');
  });

  it('matches for amounts beyond 2^53 and beyond 2^63', async () => {
    // A `number`-typed encoder passes the canonical vector and fails these, which is
    // exactly why they exist.
    for (const [index, vector] of vectors.largeValues.cases.entries()) {
      await assertVector(vector, `large[${index}]`);
    }
  });

  it('encodes a negative amount as two\u2019s complement', async () => {
    await assertVector(vectors.negative, 'negative');
  });

  it('rejects a salt that is not 32 bytes', () => {
    expect(() => bidPreimage({ auctionId: 1n, amount: 1n, salt: new Uint8Array(31) })).toThrow(
      EncodingError,
    );
  });

  it('rejects amounts outside i128', () => {
    expect(() => i128be(1n << 127n)).toThrow(EncodingError);
    expect(() => i128be(-(1n << 127n) - 1n)).toThrow(EncodingError);
    expect(() => u64be(-1n)).toThrow(EncodingError);
  });
});

describe('integer encodings', () => {
  it('writes u64 big-endian', () => {
    expect(bytesToHex(u64be(1n))).toBe('0000000000000001');
    expect(bytesToHex(u64be(0xffffffffffffffffn))).toBe('ffffffffffffffff');
  });

  it('writes i128 big-endian, signed', () => {
    expect(bytesToHex(i128be(0n))).toBe('00'.repeat(16));
    expect(bytesToHex(i128be(1n))).toBe('00'.repeat(15) + '01');
    expect(bytesToHex(i128be(-1n))).toBe('ff'.repeat(16));
    // 2^64 has a byte pattern that a 64-bit encoder would truncate to zero.
    expect(bytesToHex(i128be(1n << 64n))).toBe('00'.repeat(7) + '01' + '00'.repeat(8));
  });

  it('round-trips hex, and rejects malformed hex', () => {
    const bytes = hexToBytes('00ff10');
    expect([...bytes]).toEqual([0, 255, 16]);
    expect(() => hexToBytes('0f0')).toThrow(EncodingError);
    expect(() => hexToBytes('zz')).toThrow(EncodingError);
    expect(() => hexToBytes('')).toThrow(EncodingError);
  });

  it('enforces 32 bytes where the contract does', () => {
    expect(hexToBytes32('11'.repeat(32), 'salt').length).toBe(32);
    expect(() => hexToBytes32('11'.repeat(16), 'salt')).toThrow(/salt must be 32 bytes/);
  });
});

describe('domain separation', () => {
  it('uses the ASCII separator the contract pins', () => {
    expect(new TextDecoder().decode(utf8('subrosa.bid.v1'))).toBe('subrosa.bid.v1');
    expect(utf8('subrosa.bid.v1').length).toBe(14);
    // The layout only adds up to 70 bytes because the separator is exactly 14.
    expect(14 + 8 + 16 + 32).toBe(BID_PREIMAGE_LEN);
  });

  it('binds the auction id, so an opening cannot be replayed across auctions', async () => {
    const salt = hexToBytes('00'.repeat(32));
    const first = await computeCommitment({ auctionId: 1n, amount: 100n, salt });
    const second = await computeCommitment({ auctionId: 2n, amount: 100n, salt });
    expect(bytesToHex(first)).not.toBe(bytesToHex(second));
  });
});
