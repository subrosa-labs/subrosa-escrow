/**
 * Round arithmetic.
 *
 * `chain.ts` is a manual mirror of the contract's `round_at` / `round_time`, which is
 * what the contract uses to pick an auction's reveal round. Two things must hold:
 * my implementation must agree with drand-client's algorithm (so the round we predict
 * is the round that actually publishes), and the contract must never choose a round
 * whose beacon is already live when commits close.
 */

import { describe, expect, it } from 'vitest';
import type { ChainInfo } from 'drand-client';
import {
  QUICKNET,
  TESTNET_UNCHAINED,
  chainByHash,
  isRoundAvailable,
  msUntilRound,
  predictRevealRound,
  roundAt,
  roundTime,
} from '../drand/chain.ts';
import { drandParity } from '../drand/beacon.ts';

const QUICKNET_INFO: ChainInfo = {
  public_key: QUICKNET.publicKey,
  period: QUICKNET.periodSeconds,
  genesis_time: QUICKNET.genesisTime,
  hash: QUICKNET.chainHash,
  groupHash: QUICKNET.groupHash,
  schemeID: QUICKNET.schemeId,
  metadata: { beaconID: QUICKNET.beaconId },
};

describe('round arithmetic', () => {
  it('treats the genesis instant as round 1', () => {
    expect(roundAt(QUICKNET.genesisTime, QUICKNET)).toBe(1);
    expect(roundAt(QUICKNET.genesisTime - 1, QUICKNET)).toBe(1);
    expect(roundAt(QUICKNET.genesisTime + QUICKNET.periodSeconds, QUICKNET)).toBe(2);
  });

  it('round-trips timestamps and rounds at the boundaries', () => {
    for (const round of [1, 2, 7, 1_000, 32_000_000]) {
      const publishedAt = roundTime(round, QUICKNET);
      expect(roundAt(publishedAt, QUICKNET)).toBe(round);
      // Still the same round right up to the last second before the next one.
      expect(roundAt(publishedAt + QUICKNET.periodSeconds - 1, QUICKNET)).toBe(round);
      expect(roundAt(publishedAt + QUICKNET.periodSeconds, QUICKNET)).toBe(round + 1);
    }
  });

  it('agrees with drand-client, which is what actually publishes beacons', () => {
    // drand-client's helpers take milliseconds and a ChainInfo object.
    for (const seconds of [
      QUICKNET.genesisTime,
      QUICKNET.genesisTime + 1,
      QUICKNET.genesisTime + 1_000,
      1_800_000_000,
      Date.now() / 1000,
    ]) {
      expect(roundAt(seconds, QUICKNET)).toBe(
        drandParity.roundAt(seconds * 1_000, QUICKNET_INFO),
      );
    }

    for (const round of [1, 2, 500, 32_000_000]) {
      expect(roundTime(round, QUICKNET) * 1_000).toBe(
        drandParity.roundTime(QUICKNET_INFO, round),
      );
    }
  });

  it('reports availability and wait time consistently', () => {
    const publishedAtMs = roundTime(1_000, QUICKNET) * 1_000;
    expect(isRoundAvailable(1_000, QUICKNET, publishedAtMs - 1)).toBe(false);
    expect(isRoundAvailable(1_000, QUICKNET, publishedAtMs)).toBe(true);
    expect(msUntilRound(1_000, QUICKNET, publishedAtMs - 5_000)).toBe(5_000);
    expect(msUntilRound(1_000, QUICKNET, publishedAtMs + 1)).toBe(0);
  });

  it('rejects an unknown chain rather than defaulting to quicknet', () => {
    expect(() => chainByHash('00'.repeat(32))).toThrow(/unknown drand chain hash/);
    expect(chainByHash(QUICKNET.chainHash).beaconId).toBe('quicknet');
    expect(chainByHash(TESTNET_UNCHAINED.chainHash).beaconId).toBe('testnet-unchained-3s');
  });
});

describe('reveal round prediction', () => {
  // Mirrors the contract's derivation:
  //   roundAt(now + commitWindow * assumedLedgerSeconds) + marginRounds
  it('matches the contract formula', () => {
    const createdAt = QUICKNET.genesisTime;
    const commitWindowLedgers = 100;
    const assumedLedgerSeconds = 5;
    const marginRounds = 40;

    const predicted = predictRevealRound({
      createdAtSeconds: createdAt,
      commitWindowLedgers,
      assumedLedgerSeconds,
      marginRounds,
      chain: QUICKNET,
    });

    const estimatedCommitClose = createdAt + commitWindowLedgers * assumedLedgerSeconds;
    expect(predicted).toBe(
      Math.floor((estimatedCommitClose - QUICKNET.genesisTime) / QUICKNET.periodSeconds) + 1 + marginRounds,
    );
  });

  it('never predicts a round that is already live when commits close', () => {
    // Sweep a range of creation times and commit windows. The invariant that matters:
    // the beacon must not exist while sealed bids are still being accepted.
    for (const offset of [0, 1, 2, 3, 7, 1_000, 999_999]) {
      for (const commitWindowLedgers of [10, 100, 1_000]) {
        const createdAt = QUICKNET.genesisTime + offset;
        const predicted = predictRevealRound({
          createdAtSeconds: createdAt,
          commitWindowLedgers,
          assumedLedgerSeconds: 5,
          marginRounds: 40,
          chain: QUICKNET,
        });
        const estimatedCommitClose = createdAt + commitWindowLedgers * 5;
        expect(roundTime(predicted, QUICKNET)).toBeGreaterThan(estimatedCommitClose);
      }
    }
  });
});
