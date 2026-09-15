/**
 * Bulletin board validation.
 *
 * The point of these checks is to fail *here*, cheaply, rather than on-chain after a
 * bond is escrowed. A client that sends an envelope whose hash does not match, or a
 * non-age blob, gets a 400 with a reason instead of a doomed `seal_bid` or an
 * unrevealable bid discovered at the reveal deadline.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from '../config.ts';
import { MemoryStore } from '../store/memory.ts';
import { BulletinError, EnvelopeBulletin } from '../services/bulletin.ts';
import { computeCommitment } from '../drand/commitment.ts';
import { bytesToHex, hexToBytes32, sha256 } from '../util/bytes.ts';

const testConfig = loadConfig({
  NODE_ENV: 'test',
  WORKER_ENABLED: 'false',
  INDEXER_ENABLED: 'false',
  LOG_LEVEL: 'error',
} as NodeJS.ProcessEnv);

/** A minimal armour-shaped blob. The bulletin only inspects the header and hashes. */
function armour(payload: string): string {
  return `-----BEGIN AGE ENCRYPTED FILE-----\n${Buffer.from(payload).toString('base64')}\n-----END AGE ENCRYPTED FILE-----\n`;
}

const SALT = '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100';
const BIDDER = 'GACDNJLVD52ENYH6CDCYBYXFEO72V3UKRAMQECZAB5H5MZVZ6EJDTHWQ';

function envelopeFor(auctionId: bigint, amount: bigint): {
  envelope: string;
  envelopeHash: string;
  commitment: string;
} {
  const envelope = armour(`sealed:${auctionId}:${amount}`);
  return {
    envelope,
    envelopeHash: bytesToHex(sha256(new Uint8Array(Buffer.from(envelope, 'utf8')))),
    commitment: bytesToHex(
      computeCommitment({ auctionId, amount, salt: hexToBytes32(SALT) }),
    ),
  };
}

describe('EnvelopeBulletin.publish', () => {
  let store: MemoryStore;
  let bulletin: EnvelopeBulletin;

  beforeEach(() => {
    store = new MemoryStore();
    bulletin = new EnvelopeBulletin(store, testConfig);
  });

  it('accepts a well-formed envelope and stores it unmodified', async () => {
    const { envelope, envelopeHash, commitment } = envelopeFor(1n, 1_500_000n);

    const record = await bulletin.publish({
      auctionId: 1n,
      bidder: BIDDER,
      envelope,
      commitment,
      envelopeHash,
    });

    expect(record.envelope).toBe(envelope);
    expect(record.envelopeHash).toBe(envelopeHash);
    expect(record.commitment).toBe(commitment);
    expect(await store.countEnvelopes('1')).toBe(1);
  });

  it('rejects an envelope hash that does not match the ciphertext', async () => {
    const { envelope, commitment } = envelopeFor(1n, 1_000n);

    await expect(
      bulletin.publish({
        auctionId: 1n,
        bidder: BIDDER,
        envelope,
        commitment,
        envelopeHash: 'ab'.repeat(32),
      }),
    ).rejects.toThrow(/does not match sha256\(envelope\)/);
  });

  it('rejects a payload that is not an age-armored ciphertext', async () => {
    const { envelopeHash, commitment } = envelopeFor(1n, 1_000n);

    await expect(
      bulletin.publish({
        auctionId: 1n,
        bidder: BIDDER,
        envelope: '{"amount":"1000"}',
        commitment,
        envelopeHash,
      }),
    ).rejects.toThrow(/age-armored tlock ciphertext/);
  });

  it('rejects an oversized envelope with 413', async () => {
    const envelope = armour('x'.repeat(testConfig.MAX_ENVELOPE_BYTES + 1));
    const envelopeHash = bytesToHex(sha256(new Uint8Array(Buffer.from(envelope, 'utf8'))));

    await expect(
      bulletin.publish({
        auctionId: 1n,
        bidder: BIDDER,
        envelope,
        commitment: 'ab'.repeat(32),
        envelopeHash,
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it('is idempotent for the same bidder and the same envelope', async () => {
    const first = envelopeFor(1n, 1_000n);
    await bulletin.publish({ auctionId: 1n, bidder: BIDDER, ...first });
    const second = await bulletin.publish({ auctionId: 1n, bidder: BIDDER, ...first });

    expect(second.envelope).toBe(first.envelope);
    expect(await store.countEnvelopes('1')).toBe(1);
  });

  it('refuses to let a bidder swap in a different envelope', async () => {
    const first = envelopeFor(1n, 1_000n);
    await bulletin.publish({ auctionId: 1n, bidder: BIDDER, ...first });

    const second = envelopeFor(1n, 2_000n);
    await expect(
      bulletin.publish({ auctionId: 1n, bidder: BIDDER, ...second }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('enforces the per-auction cap', async () => {
    const limit = testConfig.MAX_ENVELOPES_PER_AUCTION;
    for (let i = 0; i < limit; i++) {
      await bulletin.publish({
        auctionId: 1n,
        bidder: Keypair.random().publicKey(),
        ...envelopeFor(1n, BigInt(i + 1)),
      });
    }

    await expect(
      bulletin.publish({ auctionId: 1n, bidder: BIDDER, ...envelopeFor(1n, 9_999n) }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('EnvelopeBulletin.verified', () => {
  it('excludes rows that no longer match their own hash', async () => {
    const store = new MemoryStore();
    const bulletin = new EnvelopeBulletin(store, testConfig);
    const good = envelopeFor(1n, 1_000n);
    await bulletin.publish({ auctionId: 1n, bidder: BIDDER, ...good });

    // Simulate corruption at rest: the row's envelope no longer matches its hash.
    const other = Keypair.random().publicKey();
    await store.putEnvelope({
      auctionId: '1',
      bidder: other,
      envelope: armour('tampered'),
      commitment: good.commitment,
      envelopeHash: good.envelopeHash,
      createdAt: new Date().toISOString(),
    });

    const { usable, corrupted } = await bulletin.verified(1n);
    expect(usable.map((row) => row.bidder)).toEqual([BIDDER]);
    expect(corrupted.map((row) => row.bidder)).toEqual([other]);
  });
});

describe('BulletinError', () => {
  it('defaults to 400 so a validation failure is not mistaken for a server fault', () => {
    expect(new BulletinError('nope').statusCode).toBe(400);
  });
});
