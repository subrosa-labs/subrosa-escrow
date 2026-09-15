/**
 * drand chain metadata for the client.
 *
 * A third mirror of `round_at` / `round_time` (contract in Rust, relayer in Node,
 * here). All three must agree. The contract is authoritative — it derives every
 * auction's reveal round itself — so this copy exists only to render countdowns and to
 * refuse to seal against a round that is already live.
 */

export interface DrandChain {
  readonly beaconId: string;
  readonly chainHash: string;
  readonly publicKey: string;
  readonly schemeId: string;
  readonly periodSeconds: number;
  readonly genesisTime: number;
  readonly baseUrl: string;
}

/** League of Entropy quicknet: 3-second rounds, unchained, BLS12-381 on G1. */
export const QUICKNET: DrandChain = {
  beaconId: 'quicknet',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  schemeId: 'bls-unchained-g1-rfc9380',
  periodSeconds: 3,
  genesisTime: 1_692_803_367,
  baseUrl:
    'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
};

/** First round published at or after `timestampSeconds`. Mirrors `SubRosaEscrow::round_at`. */
export function roundAt(timestampSeconds: number, chain: DrandChain = QUICKNET): number {
  if (timestampSeconds <= chain.genesisTime) return 1;
  return Math.floor((timestampSeconds - chain.genesisTime) / chain.periodSeconds) + 1;
}

/** Unix seconds at which `round` becomes available. Mirrors `::round_time`. */
export function roundTime(round: number, chain: DrandChain = QUICKNET): number {
  if (round <= 1) return chain.genesisTime;
  return chain.genesisTime + (round - 1) * chain.periodSeconds;
}

export function isRoundPublished(round: number, chain: DrandChain = QUICKNET, nowMs = Date.now()): boolean {
  return nowMs / 1000 >= roundTime(round, chain);
}

export function msUntilRound(round: number, chain: DrandChain = QUICKNET, nowMs = Date.now()): number {
  return Math.max(0, roundTime(round, chain) * 1000 - nowMs);
}

/** Public HTTP endpoint for a single round, used by the "verify the beacon" panel. */
export function beaconUrl(round: number, chain: DrandChain = QUICKNET): string {
  return `${chain.baseUrl}/public/${round}`;
}
