/**
 * Relayer attestations.
 *
 * The `signerIndex` in each signature is positional into `Config.relayer_pubkeys`. If
 * that index is ever wrong the signature is cryptographically valid but lands against
 * the wrong public key, and the contract rejects the whole attestation with
 * `AttestationInvalid` — a failure that is expensive to diagnose in production. These
 * tests pin the index resolution and the digest binding.
 */

import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  beaconDigestHex,
  parseRelayerSecret,
  resolveSigners,
  signBeaconDigest,
  RelayerKeyError,
} from '../drand/attestation.ts';
import { computeBeaconDigest } from '../drand/commitment.ts';
import { QUICKNET } from '../drand/chain.ts';
import { bytesToHex } from '../util/bytes.ts';
import vectors from './fixtures/golden-vectors.json' with { type: 'json' };

const CHAIN_HASH = QUICKNET.chainHash;
const RANDOMNESS = vectors.beacon.randomness;

function committee(size: number): { keys: Keypair[]; pubkeys: string[] } {
  const keys = Array.from({ length: size }, () => Keypair.random());
  return { keys, pubkeys: keys.map((key) => key.publicKey()) };
}

describe('resolveSigners', () => {
  it('maps each secret to its position in the on-chain set', () => {
    const { keys, pubkeys } = committee(3);
    const { signers, unmatched } = resolveSigners(
      [keys[2]!.secret(), keys[0]!.secret()],
      pubkeys,
    );

    expect(unmatched).toEqual([]);
    // Input order must not leak into the index; the on-chain order is authoritative.
    expect(signers.map((signer) => signer.index)).toEqual([2, 0]);
    expect(signers.find((signer) => signer.index === 2)?.publicKey).toBe(pubkeys[2]);
  });

  it('reports keys that the contract does not know about instead of signing at the wrong index', () => {
    const { keys, pubkeys } = committee(2);
    const stranger = Keypair.random();

    const { signers, unmatched } = resolveSigners([keys[0]!.secret(), stranger.secret()], pubkeys);
    expect(signers).toHaveLength(1);
    expect(signers[0]!.index).toBe(0);
    expect(unmatched).toEqual([stranger.publicKey()]);
  });

  it('rejects two secrets that resolve to the same on-chain slot', () => {
    const { keys, pubkeys } = committee(1);
    expect(() => resolveSigners([keys[0]!.secret(), keys[0]!.secret()], pubkeys)).toThrow(
      /same on-chain index/,
    );
  });

  it('rejects a malformed secret with a clear message', () => {
    expect(() => parseRelayerSecret('not-a-secret')).toThrow(RelayerKeyError);
    expect(() => parseRelayerSecret('not-a-secret')).toThrow(/not a valid Stellar secret key/);
  });
});

describe('signBeaconDigest', () => {
  it('produces signatures that verify against the signer public keys', () => {
    const { keys, pubkeys } = committee(3);
    const { signers } = resolveSigners([keys[0]!.secret(), keys[2]!.secret()], pubkeys);

    const input = {
      chainHash: CHAIN_HASH,
      round: 32_231_058,
      randomnessHex: RANDOMNESS,
      auctionId: 7n,
    };
    const signatures = signBeaconDigest(signers, input);
    const digest = computeBeaconDigest(input);

    expect(signatures.map((entry) => entry.signerIndex)).toEqual([0, 2]);
    for (const entry of signatures) {
      expect(entry.signature).toHaveLength(64);
      const signer = signers.find((candidate) => candidate.index === entry.signerIndex)!;
      expect(
        signer.keypair.verify(Buffer.from(digest), Buffer.from(entry.signature)),
      ).toBe(true);
    }
  });

  it('signs a different message for every auction', () => {
    const { keys, pubkeys } = committee(1);
    const { signers } = resolveSigners([keys[0]!.secret()], pubkeys);

    const base = {
      chainHash: CHAIN_HASH,
      round: 1_000,
      randomnessHex: RANDOMNESS,
      auctionId: 1n,
    };

    const [forOne] = signBeaconDigest(signers, base);
    const [forTwo] = signBeaconDigest(signers, { ...base, auctionId: 2n });

    const digestOne = computeBeaconDigest(base);
    expect(
      signers[0]!.keypair.verify(
        Buffer.from(digestOne),
        Buffer.from(forTwo!.signature),
      ),
    ).toBe(false);
    expect(forOne!.signature).not.toEqual(forTwo!.signature);
  });

  it('exposes the digest as hex for audit trails', () => {
    const input = {
      chainHash: vectors.beacon.chainHash,
      round: Number(vectors.beacon.round),
      randomnessHex: vectors.beacon.randomness,
      auctionId: BigInt(vectors.beacon.auctionId),
    };
    expect(beaconDigestHex(input)).toBe(vectors.beacon.digest);
    expect(bytesToHex(computeBeaconDigest(input))).toBe(vectors.beacon.digest);
  });
});
