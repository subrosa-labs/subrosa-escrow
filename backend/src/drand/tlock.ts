/**
 * Timelock encryption via drand `tlock`.
 *
 * A tlock ciphertext is an age file whose payload key is derived from a pairing
 * against the drand public key for a *future* round. The key to open it is the
 * threshold-BLS signature the League of Entropy publishes for that round, and that
 * signature becomes public to everybody at the same instant. Three properties fall
 * out, and they are the entire privacy argument of this protocol:
 *
 * 1. **Nobody can open it early.** Not the bidder, not the relayer, not a validator
 *    — the decryption key does not exist yet.
 * 2. **Nobody can withhold it.** Once the round is live the key is public, so any
 *    party holding the ciphertext can open it. There is no revealer to bribe and no
 *    "refused to reveal" attack, which is the flaw in ordinary commit-reveal.
 * 3. **Nobody can open it selectively in time.** All parties learn the key at the
 *    same moment, so no one gets a head start.
 *
 * The ciphertext is age-armored ASCII, which makes it safe to move through JSON,
 * a database column or an HTTP header without a binary encoding step.
 */

import { Buffer } from 'node:buffer';
import {
  mainnetClient,
  testnetClient,
  timelockDecrypt,
  timelockEncrypt,
  type ChainClient,
} from 'tlock-js';
import { QUICKNET, TESTNET_UNCHAINED, type DrandChain } from './chain.ts';
import { sha256, type Bytes } from '../util/bytes.ts';

export class TimelockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TimelockError';
  }
}

const clients = new Map<string, ChainClient>();
const verifiedChains = new Map<string, Promise<void>>();

/**
 * A tlock client for `chain`, pinned to that chain's identity.
 *
 * `tlock-js` only ships helper factories for two networks, so the mapping is
 * explicit and unknown chains are rejected rather than defaulted — silently sealing
 * against the wrong beacon would produce envelopes nobody can open.
 */
export function timelockClientFor(chain: DrandChain): ChainClient {
  const cached = clients.get(chain.chainHash);
  if (cached) return cached;

  let client: ChainClient;
  if (chain.chainHash === QUICKNET.chainHash) {
    client = mainnetClient();
  } else if (chain.chainHash === TESTNET_UNCHAINED.chainHash) {
    client = testnetClient();
  } else {
    throw new TimelockError(
      `no tlock client configured for drand chain ${chain.chainHash} (${chain.beaconId})`,
    );
  }

  clients.set(chain.chainHash, client);
  return client;
}

/**
 * Assert once per process that the timelock client really is talking to the chain
 * we think it is. Cheap, and it turns a subtle "all envelopes are unopenable" bug
 * into a startup failure.
 */
export async function assertTimelockChain(client: ChainClient, chain: DrandChain): Promise<void> {
  const existing = verifiedChains.get(chain.chainHash);
  if (existing) return existing;

  const check = (async () => {
    const info = await client.chain().info();
    if (info.hash !== chain.chainHash) {
      throw new TimelockError(
        `timelock client is bound to ${info.hash} but ${chain.chainHash} was requested`,
      );
    }
  })();

  verifiedChains.set(chain.chainHash, check);
  return check;
}

/**
 * Seal `plaintext` so it can only be opened once `round` is published.
 *
 * `round` must be in the future: tlock will happily encrypt to a round that has
 * already passed, which would produce a "sealed" bid that anyone can read
 * immediately. Callers are expected to pass a contract-derived round, and
 * `sealBid` refuses rounds that are not strictly ahead of the chain.
 */
export async function sealToRound(
  plaintext: Bytes,
  round: number,
  chain: DrandChain,
): Promise<string> {
  if (round < 1) throw new TimelockError(`reveal round must be >= 1, got ${round}`);
  const client = timelockClientFor(chain);
  try {
    return await timelockEncrypt(round, Buffer.from(plaintext), client);
  } catch (error) {
    throw new TimelockError(`failed to seal envelope for round ${round}`, { cause: error });
  }
}

/**
 * Open a sealed envelope. Throws while the round is still in the future — that
 * failure is the security property, not a bug.
 */
export async function openEnvelope(envelope: string, chain: DrandChain): Promise<Bytes> {
  const client = timelockClientFor(chain);
  try {
    const buffer = await timelockDecrypt(envelope, client);
    return new Uint8Array(buffer);
  } catch (error) {
    throw new TimelockError(
      'failed to open envelope: the reveal round may not be published yet, or the beacon is unreachable',
      { cause: error },
    );
  }
}

/** `sha256(envelope)`, the value anchored on-chain as `envelope_hash`. */
export function envelopeHash(envelope: string): Bytes {
  return sha256(new Uint8Array(Buffer.from(envelope, 'utf8')));
}

/** True when the payload looks like an age-armored tlock file. */
export function isArmoredEnvelope(envelope: string): boolean {
  return envelope.startsWith('-----BEGIN AGE ENCRYPTED FILE-----');
}
