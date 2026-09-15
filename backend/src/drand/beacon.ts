/**
 * Verified drand beacon access.
 *
 * Every beacon that leaves this module has had its BLS signature checked by
 * `drand-client` against the pinned public key for the configured chain. That check
 * is the reason the relayer's ed25519 quorum is a meaningful attestation rather than
 * a rubber stamp: we sign a randomness value only after cryptography — not an API
 * response — has told us it is real.
 */

import {
  HttpCachingChain,
  HttpChainClient,
  fetchBeacon,
  roundAt as drandRoundAt,
  roundTime as drandRoundTime,
  type ChainInfo,
  type RandomnessBeacon,
} from 'drand-client';
import type { DrandChain } from './chain.ts';

export interface VerifiedBeacon {
  readonly round: number;
  /** 32-byte randomness, hex. This is what the contract digests. */
  readonly randomness: string;
  /** BLS signature, hex. Kept for audit trails and CLI verification. */
  readonly signature: string;
  readonly chainHash: string;
}

export interface BeaconMetadata {
  readonly chainHash: string;
  readonly beaconId: string;
  readonly periodSeconds: number;
  readonly genesisTime: number;
  readonly publicKey: string;
  readonly schemeId: string;
  /** Latest round the chain has published, according to chain info + wall clock. */
  readonly latestRound: number;
}

export class BeaconUnavailableError extends Error {
  constructor(
    readonly round: number,
    cause?: unknown,
  ) {
    super(`beacon for round ${round} is not available yet`);
    this.name = 'BeaconUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Build a client pinned to `chain`.
 *
 * `disableBeaconVerification: false` is the default, but it is set explicitly here
 * because silently turning verification off is exactly the kind of change that
 * would invalidate the whole attestation story without breaking any test.
 */
export function createDrandClient(chain: DrandChain): HttpChainClient {
  const options = {
    disableBeaconVerification: false,
    noCache: false,
    chainVerificationParams: {
      chainHash: chain.chainHash,
      publicKey: chain.publicKey,
    },
  };
  return new HttpChainClient(new HttpCachingChain(chain.baseUrl, options), options, {
    userAgent: 'subrosa-relayer/0.1.0',
  });
}

/** Fetch and verify the beacon for an exact round. */
export async function fetchVerifiedBeacon(
  client: HttpChainClient,
  chain: DrandChain,
  round: number,
): Promise<VerifiedBeacon> {
  let beacon: RandomnessBeacon;
  try {
    beacon = await fetchBeacon(client, round);
  } catch (error) {
    throw new BeaconUnavailableError(round, error);
  }

  if (beacon.round !== round) {
    throw new Error(`drand returned round ${beacon.round} when asked for ${round}`);
  }

  assertRandomnessShape(beacon.randomness);

  return {
    round: beacon.round,
    randomness: beacon.randomness,
    signature: beacon.signature,
    chainHash: chain.chainHash,
  };
}

/** Chain info straight from the beacon network, cross-checked against our constants. */
export async function fetchChainInfo(
  client: HttpChainClient,
  chain: DrandChain,
): Promise<BeaconMetadata> {
  const info: ChainInfo = await client.chain().info();

  if (info.hash !== chain.chainHash) {
    throw new Error(
      `drand chain hash mismatch: endpoint served ${info.hash} but ${chain.chainHash} is pinned`,
    );
  }
  if (info.public_key !== chain.publicKey) {
    throw new Error('drand public key mismatch: refusing to trust this endpoint');
  }

  return {
    chainHash: info.hash,
    beaconId: info.metadata.beaconID,
    periodSeconds: info.period,
    genesisTime: info.genesis_time,
    publicKey: info.public_key,
    schemeId: info.schemeID,
    latestRound: drandRoundAt(Date.now(), info),
  };
}

/**
 * Round arithmetic straight from drand-client, used only by parity tests.
 *
 * The production path uses `chain.ts`, whose implementation mirrors the contract.
 * Asserting the two agree keeps us from shipping a reveal round that the contract
 * would compute differently.
 */
export const drandParity = {
  roundAt: (timeMs: number, info: ChainInfo): number => drandRoundAt(timeMs, info),
  roundTime: (info: ChainInfo, round: number): number => drandRoundTime(info, round),
};

function assertRandomnessShape(randomness: string): void {
  if (!/^[0-9a-f]{64}$/i.test(randomness)) {
    throw new Error(
      `beacon randomness must be 32 bytes of hex, got ${randomness.length} characters`,
    );
  }
}
