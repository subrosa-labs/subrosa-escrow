/**
 * drand chain metadata and round arithmetic.
 *
 * The round maths here is the exact mirror of `SubRosaEscrow::round_at` and
 * `::round_time` in the contract. The contract derives the reveal round for every
 * auction itself, so this module exists to *predict* the same answer for the UI and
 * to convert between rounds and wall-clock time when scheduling reveals.
 */

export interface DrandChain {
  /** Human-readable network name, e.g. `quicknet`. */
  readonly beaconId: string;
  readonly chainHash: string;
  /** 96-byte BLS12-381 G1 public key, hex. */
  readonly publicKey: string;
  readonly groupHash: string;
  readonly schemeId: string;
  /** Seconds between rounds. */
  readonly periodSeconds: number;
  /** Unix seconds of round 1. */
  readonly genesisTime: number;
  /** Default HTTP API base. */
  readonly baseUrl: string;
}

/**
 * League of Entropy `quicknet`: 3-second rounds, unchained, BLS12-381 signatures on
 * G1 with the RFC 9380 hash-to-curve suite.
 *
 * Chosen over the older 30-second `default` network because a 30-second cadence
 * would make every reveal window at least 30 seconds long for no reason, and over
 * `fastnet` because quicknet is the network with real operator diversity.
 */
export const QUICKNET: DrandChain = {
  beaconId: 'quicknet',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeId: 'bls-unchained-g1-rfc9380',
  periodSeconds: 3,
  genesisTime: 1_692_803_367,
  baseUrl: 'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
};

/** The drand test network, for local development only. */
export const TESTNET_UNCHAINED: DrandChain = {
  beaconId: 'testnet-unchained-3s',
  chainHash: '7672797f548f3f4748ac4bf3352fc6c6b6468c9ad40ad456a397545c6e2df5bf',
  publicKey:
    '8200fc249deb0148eb918d6e213980c5d01acd7fc251900d9260136da3b54836ce125172399ddc69c4e3e11429b62c11',
  groupHash: '65083634d852ae169e21b6ce5f0410be9ed4cc679b9970236f7875cff667e13d',
  schemeId: 'pedersen-bls-unchained',
  periodSeconds: 3,
  genesisTime: 1_651_677_099,
  baseUrl: 'https://pl-us.testnet.drand.sh/7672797f548f3f4748ac4bf3352fc6c6b6468c9ad40ad456a397545c6e2df5bf',
};

export const KNOWN_CHAINS: readonly DrandChain[] = [QUICKNET, TESTNET_UNCHAINED];

export class UnknownChainError extends Error {
  constructor(chainHash: string) {
    super(
      `unknown drand chain hash ${chainHash}; known chains: ${KNOWN_CHAINS.map((c) => c.chainHash).join(', ')}`,
    );
    this.name = 'UnknownChainError';
  }
}

export function chainByHash(chainHash: string): DrandChain {
  const found = KNOWN_CHAINS.find((chain) => chain.chainHash === chainHash);
  if (!found) throw new UnknownChainError(chainHash);
  return found;
}

/**
 * First round published at or after `timestampSeconds`.
 *
 * Mirrors `SubRosaEscrow::round_at`, including rounding down at exactly the genesis
 * instant (round 1 is live at `genesisTime`).
 */
export function roundAt(timestampSeconds: number, chain: DrandChain): number {
  if (timestampSeconds <= chain.genesisTime) return 1;
  return Math.floor((timestampSeconds - chain.genesisTime) / chain.periodSeconds) + 1;
}

/** Unix seconds at which `round` is published. Mirrors `::round_time`. */
export function roundTime(round: number, chain: DrandChain): number {
  if (round <= 1) return chain.genesisTime;
  return chain.genesisTime + (round - 1) * chain.periodSeconds;
}

/** Whether the beacon for `round` can already be fetched. */
export function isRoundAvailable(round: number, chain: DrandChain, nowMs = Date.now()): boolean {
  return nowMs / 1000 >= roundTime(round, chain);
}

/** Milliseconds until `round` is published; zero once it is. */
export function msUntilRound(round: number, chain: DrandChain, nowMs = Date.now()): number {
  return Math.max(0, roundTime(round, chain) * 1000 - nowMs);
}

/**
 * Replay the contract's reveal-round derivation so the UI can show the exact round
 * a sealed envelope will open at, before the auction exists on-chain.
 *
 * Must stay byte-for-byte equivalent to `create_auction` in the contract:
 * `roundAt(now + commitWindow * assumedLedgerSeconds) + marginRounds`.
 */
export function predictRevealRound(params: {
  readonly createdAtSeconds: number;
  readonly commitWindowLedgers: number;
  readonly assumedLedgerSeconds: number;
  readonly marginRounds: number;
  readonly chain: DrandChain;
}): number {
  const estimatedCommitClose =
    params.createdAtSeconds + params.commitWindowLedgers * params.assumedLedgerSeconds;
  return roundAt(estimatedCommitClose, params.chain) + params.marginRounds;
}
