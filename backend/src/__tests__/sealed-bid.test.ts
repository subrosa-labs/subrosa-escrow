/** Sealed-bid payload encoding and validation. */

import { describe, expect, it } from 'vitest';
import {
  SEALED_BID_VERSION,
  SealedBidFormatError,
  decodeSealedBid,
  encodeSealedBid,
  type SealedBid,
} from '../drand/sealed-bid.ts';
import { QUICKNET } from '../drand/chain.ts';
import { computeCommitment } from '../drand/commitment.ts';
import { bytesToHex, hexToBytes32 } from '../util/bytes.ts';
import { assertRoundIsFuture } from '../drand/envelope.ts';

const SALT = '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100';

function sampleBid(overrides: Partial<SealedBid> = {}): SealedBid {
  return {
    v: SEALED_BID_VERSION,
    auctionId: '42',
    amount: '1500000',
    salt: SALT,
    commitment: bytesToHex(
      computeCommitment({ auctionId: 42n, amount: 1_500_000n, salt: hexToBytes32(SALT) }),
    ),
    revealRound: 32_231_100,
    chainHash: QUICKNET.chainHash,
    bidder: 'GACDNJLVD52ENYH6CDCYBYXFEO72V3UKRAMQECZAB5H5MZVZ6EJDTHWQ',
    createdAt: 1_755_000_000,
    ...overrides,
  };
}

describe('encodeSealedBid', () => {
  it('round-trips through decode', () => {
    const bid = sampleBid();
    const decoded = decodeSealedBid(encodeSealedBid(bid));
    expect(decoded).toEqual(bid);
  });

  it('is byte-for-byte deterministic', () => {
    const bid = sampleBid();
    expect(bytesToHex(encodeSealedBid(bid))).toBe(bytesToHex(encodeSealedBid(bid)));
  });

  it('emits keys in a fixed order regardless of the input object order', () => {
    const bid = sampleBid();
    const reordered: SealedBid = {
      createdAt: bid.createdAt,
      bidder: bid.bidder,
      chainHash: bid.chainHash,
      revealRound: bid.revealRound,
      commitment: bid.commitment,
      salt: bid.salt,
      amount: bid.amount,
      auctionId: bid.auctionId,
      v: bid.v,
    };
    expect(bytesToHex(encodeSealedBid(reordered))).toBe(bytesToHex(encodeSealedBid(bid)));

    const text = Buffer.from(encodeSealedBid(bid)).toString('utf8');
    expect(text.startsWith('{"v":1,"auctionId":"42","amount":"1500000","salt":')).toBe(true);
  });

  it('keeps amounts above 2^53 intact as strings', () => {
    const huge = '170141183460469231731687303715884105727';
    const decoded = decodeSealedBid(
      encodeSealedBid(sampleBid({ auctionId: '18446744073709551615', amount: huge })),
    );
    expect(BigInt(decoded.amount)).toBe(170141183460469231731687303715884105727n);
    expect(decoded.auctionId).toBe('18446744073709551615');
  });
});

describe('decodeSealedBid', () => {
  it('rejects a payload that is not JSON', () => {
    expect(() => decodeSealedBid(new Uint8Array(Buffer.from('not json')))).toThrow(
      SealedBidFormatError,
    );
  });

  it('rejects a wrong version', () => {
    const encoded = encodeSealedBid(sampleBid());
    const mutated = Buffer.from(encoded).toString('utf8').replace('"v":1', '"v":2');
    expect(() => decodeSealedBid(new Uint8Array(Buffer.from(mutated)))).toThrow(/failed validation/);
  });

  it('rejects a short salt', () => {
    expect(() => decodeSealedBid(encodeSealedBid(sampleBid({ salt: 'ab'.repeat(16) })))).toThrow(
      /salt must be 32 bytes/,
    );
  });

  it('rejects a non-numeric amount', () => {
    expect(() =>
      decodeSealedBid(encodeSealedBid(sampleBid({ amount: '1.5e6' }))),
    ).toThrow(/amount must be a non-negative decimal integer string/);
  });

  it('lists every problem at once', () => {
    expect(() =>
      decodeSealedBid(encodeSealedBid(sampleBid({ amount: '-1', revealRound: 0 }))),
    ).toThrow(/amount.*revealRound/s);
  });

  it('accepts a payload with the optional fields omitted', () => {
    const minimal = sampleBid();
    delete (minimal as { bidder?: string }).bidder;
    delete (minimal as { createdAt?: number }).createdAt;
    const decoded = decodeSealedBid(encodeSealedBid(minimal));
    expect(decoded.bidder).toBeUndefined();
    expect(decoded.createdAt).toBeUndefined();
  });
});

describe('assertRoundIsFuture', () => {
  it('accepts a round that has not been published yet', () => {
    const round = Math.floor((Date.now() - QUICKNET.genesisTime) / 1_000 / QUICKNET.periodSeconds) + 50;
    expect(() => assertRoundIsFuture(round, QUICKNET)).not.toThrow();
  });

  it('refuses a round that has already been published', () => {
    // This is the quiet privacy failure the guard exists for: tlock will happily
    // encrypt to a past round, producing a "sealed" envelope anyone can read.
    expect(() => assertRoundIsFuture(1, QUICKNET)).toThrow(/would expose the bid immediately/);
  });
});
