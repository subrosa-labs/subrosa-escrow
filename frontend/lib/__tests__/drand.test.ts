/**
 * Round arithmetic, client side.
 *
 * The browser needs this for one reason: to refuse to seal against a round that has
 * already published, and to render a countdown. It is a third mirror of the contract's
 * `round_at` and the relayer's `chain.ts`, so the boundaries are pinned here rather than
 * left to a `Math.floor` that nobody re-reads.
 */

import { describe, expect, it } from 'vitest';
import {
  QUICKNET,
  beaconUrl,
  isRoundPublished,
  msUntilRound,
  roundAt,
  roundTime,
} from '../drand.ts';

describe('quicknet parameters', () => {
  it('pins the values the contract and relayer also pin', () => {
    expect(QUICKNET.chainHash).toBe(
      '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    );
    expect(QUICKNET.periodSeconds).toBe(3);
    expect(QUICKNET.genesisTime).toBe(1_692_803_367);
    expect(QUICKNET.schemeId).toBe('bls-unchained-g1-rfc9380');
  });
});

describe('roundAt / roundTime', () => {
  it('treats the genesis instant as round 1', () => {
    expect(roundAt(QUICKNET.genesisTime)).toBe(1);
    expect(roundAt(QUICKNET.genesisTime - 1)).toBe(1);
    expect(roundAt(QUICKNET.genesisTime + 3)).toBe(2);
  });

  it('round-trips at the boundaries', () => {
    for (const round of [1, 2, 7, 1_000, 32_000_000]) {
      const publishedAt = roundTime(round);
      expect(roundAt(publishedAt)).toBe(round);
      expect(roundAt(publishedAt + 2)).toBe(round);
      expect(roundAt(publishedAt + 3)).toBe(round + 1);
    }
  });

  it('matches the contract formula for a future commit close', () => {
    // contracts/subrosa_escrow/src/lib.rs:
    //   reveal_round = round_at(now + commit_window * SECONDS_PER_LEDGER) + margin_rounds
    const now = QUICKNET.genesisTime + 12_345;
    const commitWindowLedgers = 3_456;
    const assumedLedgerSeconds = 5;
    const marginRounds = 40;

    const estimatedClose = now + commitWindowLedgers * assumedLedgerSeconds;
    const expected =
      Math.floor((estimatedClose - QUICKNET.genesisTime) / QUICKNET.periodSeconds) + 1 + marginRounds;

    expect(roundAt(estimatedClose) + marginRounds).toBe(expected);
    // The whole point of the margin: the beacon must not exist while commits are open.
    expect(roundTime(expected)).toBeGreaterThan(estimatedClose);
  });
});

describe('availability', () => {
  const publishedAtMs = roundTime(1_000) * 1_000;

  it('reports a round as published only at or after its time', () => {
    expect(isRoundPublished(1_000, QUICKNET, publishedAtMs - 1)).toBe(false);
    expect(isRoundPublished(1_000, QUICKNET, publishedAtMs)).toBe(true);
  });

  it('never returns a negative wait', () => {
    expect(msUntilRound(1_000, QUICKNET, publishedAtMs - 5_000)).toBe(5_000);
    expect(msUntilRound(1_000, QUICKNET, publishedAtMs + 1)).toBe(0);
  });

  it('points at the chain-specific beacon endpoint', () => {
    // A generic api.drand.sh/public/<n> would silently query the wrong chain.
    expect(beaconUrl(1_000)).toBe(`${QUICKNET.baseUrl}/public/1000`);
    expect(beaconUrl(1_000)).toContain(QUICKNET.chainHash);
  });
});
