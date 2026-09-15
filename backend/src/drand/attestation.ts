/**
 * Relayer attestations.
 *
 * Soroban has no BN254 pairing host function, so the contract cannot check drand's
 * BLS signature itself. Instead it checks an M-of-N ed25519 quorum over a digest
 * that binds `(chain_hash, round, randomness, auction_id)`.
 *
 * This module is the honest half of that trade:
 *
 * 1. the relayer fetches the beacon through `drand-client`, which **verifies the
 *    real BLS signature** against the pinned quicknet public key before we ever see
 *    the randomness;
 * 2. only then does the relayer sign the quorum digest.
 *
 * So the quorum cannot be used to attest a forged beacon unless the operators
 * themselves are compromised. That is a trust assumption, not a proof, and it is
 * recorded as such in `FUNDING.json -> protocol.privacy_model.beacon`.
 *
 * Relayer keys are ordinary Stellar ed25519 keypairs (`S...`), which keeps
 * operations boring: the same key generation, storage and rotation tooling that a
 * Stellar operator already has.
 */

import { Keypair } from '@stellar/stellar-sdk';
import { computeBeaconDigest, type BeaconDigestInput } from './commitment.ts';

export interface RelayerSigner {
  /** Position in the on-chain `Config.relayer_pubkeys` vector. */
  readonly index: number;
  /** Stellar `G...` address of this relayer. */
  readonly publicKey: string;
  readonly keypair: Keypair;
}

export interface AttestationSignature {
  readonly signerIndex: number;
  /** 64-byte ed25519 signature over the beacon digest. */
  readonly signature: Uint8Array;
}

export class RelayerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayerKeyError';
  }
}

/** Parse a Stellar `S...` secret. Throws with a useful message on a malformed key. */
export function parseRelayerSecret(secret: string): Keypair {
  try {
    return Keypair.fromSecret(secret.trim());
  } catch {
    throw new RelayerKeyError(
      `RELAYER_SECRET_KEYS contains an entry that is not a valid Stellar secret key`,
    );
  }
}

/**
 * Match configured secrets against the relayer set that is actually on-chain.
 *
 * A key whose public half is not in `onChainPubkeys` is dropped rather than
 * silently signing at the wrong index — a mismatch there would produce a valid
 * signature that the contract rejects with `AttestationInvalid`, which is far
 * harder to debug than a startup warning.
 */
export function resolveSigners(
  secrets: readonly string[],
  onChainPubkeys: readonly string[],
): { signers: RelayerSigner[]; unmatched: string[] } {
  const normalised = onChainPubkeys.map((key) => key.toUpperCase());
  const signers: RelayerSigner[] = [];
  const unmatched: string[] = [];

  for (const secret of secrets) {
    const keypair = parseRelayerSecret(secret);
    const publicKey = keypair.publicKey();
    const index = normalised.indexOf(publicKey.toUpperCase());
    if (index === -1) {
      unmatched.push(publicKey);
      continue;
    }
    if (signers.some((signer) => signer.index === index)) {
      throw new RelayerKeyError(
        `two configured relayers resolve to the same on-chain index ${index}`,
      );
    }
    signers.push({ index, publicKey, keypair });
  }

  return { signers, unmatched };
}

/**
 * Sign the beacon digest with every signer we hold.
 *
 * Callers must compare `signatures.length` against the configured threshold, and
 * should *not* submit a sub-threshold attestation: the transaction would fail
 * on-chain and burn a fee for nothing.
 */
export function signBeaconDigest(
  signers: readonly RelayerSigner[],
  input: BeaconDigestInput,
): AttestationSignature[] {
  const digest = computeBeaconDigest(input);
  return signers
    .map((signer) => ({
      signerIndex: signer.index,
      signature: new Uint8Array(signer.keypair.sign(Buffer.from(digest))),
    }))
    .sort((a, b) => a.signerIndex - b.signerIndex);
}

/** The digest alone, for tests and for `--dry-run` reporting. */
export function beaconDigestHex(input: BeaconDigestInput): string {
  return Buffer.from(computeBeaconDigest(input)).toString('hex');
}
